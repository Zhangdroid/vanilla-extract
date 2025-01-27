import path from 'path';
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite';
import { normalizePath } from 'vite';
import outdent from 'outdent';
import {
  cssFileFilter,
  processVanillaFile,
  compile,
  getPackageInfo,
  IdentifierOption,
  addFileScope,
  stringifyFileScope,
  parseFileScope,
} from '@vanilla-extract/integration';

const styleUpdateEvent = (fileId: string) =>
  `vanilla-extract-style-update:${fileId}`;

const virtualPrefix = 'virtual:vanilla-extract:';

interface Options {
  identifiers?: IdentifierOption;
}
export function vanillaExtractPlugin({ identifiers }: Options = {}): Plugin {
  let config: ResolvedConfig;
  let packageInfo: ReturnType<typeof getPackageInfo>;
  let server: ViteDevServer;
  const cssMap = new Map<string, string>();

  let virtualExt: string;

  return {
    name: 'vanilla-extract',
    enforce: 'pre',
    configureServer(_server) {
      server = _server;
    },
    config(_userConfig, env) {
      const include =
        env.command === 'serve' ? ['@vanilla-extract/css/injectStyles'] : [];

      return {
        optimizeDeps: { include },
        ssr: {
          external: [
            '@vanilla-extract/css',
            '@vanilla-extract/css/fileScope',
            '@vanilla-extract/css/adapter',
          ],
        },
      };
    },
    configResolved(resolvedConfig) {
      config = resolvedConfig;

      virtualExt = `.vanilla.${config.command === 'serve' ? 'js' : 'css'}`;

      packageInfo = getPackageInfo(config.root);
    },
    resolveId(id) {
      if (id.indexOf(virtualPrefix) === 0) {
        return id;
      }
    },
    load(id) {
      if (id.indexOf(virtualPrefix) === 0) {
        const fileScopeId = id.slice(
          virtualPrefix.length,
          id.indexOf(virtualExt),
        );

        if (!cssMap.has(fileScopeId)) {
          throw new Error(`Unable to locate ${fileScopeId} in the CSS map.`);
        }

        const css = cssMap.get(fileScopeId)!;

        if (!server) {
          return css;
        }

        const fileScope = parseFileScope(fileScopeId);

        return outdent`
          import { injectStyles } from '@vanilla-extract/css/injectStyles';
          
          const inject = (css) => injectStyles({
            fileScope: ${JSON.stringify(fileScope)},
            css
          });

          inject(${JSON.stringify(css)});

          import.meta.hot.on('${styleUpdateEvent(fileScopeId)}', (css) => {
            inject(css);
          });   
        `;
      }

      return null;
    },
    async transform(code, id, ssr) {
      if (!cssFileFilter.test(id)) {
        return null;
      }

      const index = id.indexOf('?');
      const validId = index === -1 ? id : id.substring(0, index);

      if (ssr) {
        return addFileScope({
          source: code,
          filePath: normalizePath(path.relative(packageInfo.dirname, validId)),
          packageInfo,
        }).source;
      }

      const { source, watchFiles } = await compile({
        filePath: validId,
        cwd: config.root,
      });

      for (const file of watchFiles) {
        // In start mode, we need to prevent the file from rewatching itself.
        // If it's a `build --watch`, it needs to watch everything.
        if (config.command === 'build' || file !== id) {
          this.addWatchFile(file);
        }
      }

      return processVanillaFile({
        source,
        filePath: validId,
        identOption:
          identifiers ?? (config.mode === 'production' ? 'short' : 'debug'),
        serializeVirtualCssPath: ({ fileScope, source }) => {
          const fileId = stringifyFileScope(fileScope);
          const id = `${virtualPrefix}${fileId}${virtualExt}`;

          if (server && cssMap.has(fileId) && cssMap.get(fileId) !== source) {
            const { moduleGraph } = server;
            const module = moduleGraph.getModuleById(id);

            if (module) {
              moduleGraph.invalidateModule(module);
            }

            server.ws.send({
              type: 'custom',
              event: styleUpdateEvent(fileId),
              data: source,
            });
          }

          cssMap.set(fileId, source);

          return `import "${id}";`;
        },
      });
    },
  };
}
