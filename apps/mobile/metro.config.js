// Expo + pnpm monorepo Metro configuration.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch the whole monorepo so changes in packages/* trigger reloads.
config.watchFolders = [monorepoRoot];

// Resolve modules from the app first, then the monorepo root (hoisted).
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Force a single copy of React (and react-dom, for web) so pnpm's nested store
// never produces the "invalid hook call / two Reacts" error. `extraNodeModules`
// alone isn't enough - some deps resolve `react` relative to their own
// `.pnpm/<pkg>/node_modules`, so redirect every `react*` request explicitly.
const reactAliases = {
  react: require.resolve('react', { paths: [monorepoRoot] }),
  'react/jsx-runtime': require.resolve('react/jsx-runtime', { paths: [monorepoRoot] }),
  'react/jsx-dev-runtime': require.resolve('react/jsx-dev-runtime', { paths: [monorepoRoot] }),
  'react-dom': require.resolve('react-dom', { paths: [monorepoRoot] }),
};
config.resolver.extraNodeModules = {
  react: path.resolve(monorepoRoot, 'node_modules/react'),
  'react-dom': path.resolve(monorepoRoot, 'node_modules/react-dom'),
};
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const alias = reactAliases[moduleName];
  if (alias) return { type: 'sourceFile', filePath: alias };
  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
