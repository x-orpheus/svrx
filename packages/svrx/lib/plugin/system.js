const nodeResolve = require('resolve');
const libPath = require('path');

// const Plugin = require('./plugin')
const { ASSET_FIELDS, BUILTIN_PLUGIN } = require('../constant');
const { normalizePluginName } = require('../util/helper');
const logger = require('../util/logger');
const semver = require('../util/semver');
const { install, getSatisfiedVersion, listMatchedPackageVersion } = require('./npm');

const PLUGIN_MAP = Symbol('PLUGIN_MAP');

class PluginSystem {
    /**
     * @param {Array} pluginlist
     */
    constructor({ events, config, middleware, injector, io }) {
        this.middleware = middleware;
        this.injector = injector;
        this.events = events;
        this.config = config;
        this.io = io;
        this[PLUGIN_MAP] = {};
    }

    get(name) {
        return this[PLUGIN_MAP][name];
    }

    async load(plugins) {
        return plugins.reduce((left, right) => left.then(() => this.loadOne(right)), Promise.resolve());
    }

    // @TODO: 重构重复代码过多
    async loadOne(pluginConfig) {
        const config = this.config;
        const pluginMap = this[PLUGIN_MAP];
        const name = pluginConfig.getInfo('name');
        const path = BUILTIN_PLUGIN.includes(name)
            ? libPath.join(__dirname, `./svrx-plugin-${name}`)
            : pluginConfig.getInfo('path');
        const hooks = pluginConfig.getInfo('hooks');
        const assets = pluginConfig.getInfo('assets');
        const inplace = pluginConfig.getInfo('inplace') || hooks || assets;

        if (pluginMap[name]) return pluginMap[name];

        // load inplace plugin
        if (inplace) {
            return (pluginMap[name] = {
                name,
                module: pluginConfig.getInfo(),
                path: config.get('root'),
                pluginConfig
            });
        }

        // load local plugin by name
        const resolveRet = await new Promise((resolve) => {
            const normalizedName = normalizePluginName(name);
            nodeResolve(
                normalizedName,
                {
                    basedir: config.get('root')
                },
                (err, res, pkg) => {
                    if (err) return resolve(null); // suppress error
                    const svrxPattern = (pkg.engines && pkg.engines.svrx) || '*';
                    if (semver.satisfies(svrxPattern)) {
                        resolve({
                            path: libPath.join(res.split(normalizedName)[0], normalizedName),
                            module: require(res),
                            pkg: pkg
                        });
                    }
                }
            );
        });
        if (resolveRet) {
            return (pluginMap[name] = {
                name,
                path: resolveRet.path,
                module: resolveRet.module,
                version: resolveRet.pkg.version,
                pluginConfig
            });
        }

        // load local plugin by path
        if (path && !pluginConfig.getInfo('install')) {
            // no install , just require
            let pkg;
            try {
                pkg = require(libPath.join(path, 'package.json'));
            } catch (e) {
                pkg = {};
            }
            return (pluginMap[name] = {
                name,
                path,
                module: require(path),
                version: pkg.version,
                pluginConfig
            });
        }

        // install and load plugin
        const installOptions = {
            path: config.get('root'),
            npmLoad: {
                // loaded: true,
                prefix: config.get('root')
            }
        };
        if (path === undefined) {
            // remote
            const targetVersion = await getSatisfiedVersion(name, pluginConfig.getInfo('version'));
            if (!targetVersion) {
                // @TODO
                throw Error(
                    `Unmatched plugin version, please use other version\n` +
                        `${(await listMatchedPackageVersion(name)).join('\n')}`
                );
            }
            installOptions.name = normalizePluginName(name);
            installOptions.version = targetVersion;
        } else {
            // local install
            installOptions.name = path;
            installOptions.localInstall = true;
        }
        const installRet = await install(installOptions);

        logger.log(`plugin ${name} installed completely!`);

        let pkg;
        try {
            pkg = require(libPath.join(path || installRet.path, 'package.json'));
        } catch (e) {
            pkg = {};
        }
        return (pluginMap[name] = {
            name,
            path: path || installRet.path,
            module: require(path || installRet.path),
            version: pkg.version,
            pluginConfig
        });
    }

    /**
     * [{ name: 'live-reload', version: '0.9.0', config: { enable: true} }]
     * @param {Array} plugins
     */
    handleProps(models, props) {
        // @TODO
        return props;
    }

    async build() {
        const plugins = Object.values(this[PLUGIN_MAP]);
        return Promise.all(plugins.map((plugin) => this.buildOne(plugin)));
    }

    async buildOne(plugin) {
        const { module, name, path, pluginConfig } = plugin;
        const io = this.io;
        const { hooks = {}, assets, services, configs, watches = [] } = module;
        const { onRoute, onCreate, onOptionChange } = hooks;
        // @TODO Plugin onCreate Logic
        // onActive? onDeactive

        // watch builtin option change
        this.config.watch((event) => {
            const changedKeys = watches.filter((key) => event.affect(key));

            if (onOptionChange) {
                onOptionChange.call(plugin, {
                    keys: changedKeys,
                    prevConfig: event.prev,
                    config: event.current
                });
            }
        });

        if (configs) {
            // todo update plugin configs
        }

        // regist service
        if (services) {
            for (let i in services) {
                if (services.hasOwnProperty(i)) {
                    io.registService(i, services[i]);
                }
            }
        }

        // inject custom script and style
        // @TODO: more script type support
        if (assets) {
            // central testing
            const test = assets.test;

            ASSET_FIELDS.forEach((field) => {
                if (Array.isArray(assets[field]) && assets[field].length) {
                    assets[field].forEach((def) => {
                        // short way support
                        if (typeof def === 'string') {
                            def = { filename: def };
                        }
                        // to absolute filepath
                        if (def.filename && !libPath.isAbsolute(def.filename)) {
                            def.filename = libPath.join(path, def.filename);
                        }
                        if (!def.test) def.test = test;

                        this.injector.add(field, def);
                    });
                }
            });
        }
        if (onRoute) {
            this.middleware.add(name, {
                priority: module.priority,
                onCreate(config) {
                    // todo here is this.config
                    return async (ctx, next) => {
                        return onRoute(ctx, next, { config, logger });
                    };
                }
            });
        }

        if (onCreate) {
            return onCreate.call(plugin, {
                middleware: this.middleware,
                injector: this.injector,
                events: this.events,
                config: BUILTIN_PLUGIN.includes(name) ? this.config : pluginConfig,
                io: this.io,
                logger
            });
        }
    }
}

module.exports = PluginSystem;
