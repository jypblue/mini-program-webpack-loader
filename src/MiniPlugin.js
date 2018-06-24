require('console.table');
const colors = require('colors');
const fs = require('fs')
const {
  dirname,
  join,
  relative,
  extname,
  basename,
  isAbsolute
} = require('path');

const loader = require('./loader');
const utils = require('./utils');
const MiniTemplate = require('./MiniTemplate');
const MiniProgam = require('./MiniProgram')
const DEPS_MAP = {}

class MiniPlugin extends MiniProgam {
  constructor (options) {
    super(options)
  }

  apply(compiler) {
    this.compiler = compiler;
    this.outputPath = compiler.options.output.path;
    this.compilerContext = join(compiler.context, 'src');

    this._appending = [];

    // 向 loader 中传递插件实例
    loader.$applyPluginInstance(this);

    // 使用模板插件，用于设置输出格式
    new MiniTemplate(this).apply(compiler);

    // 加载入口文件，必须在 environment 前完成
    this.loadEntrys(this.compiler.options.entry);

    // 获取打包后路径（在 loader 中有使用）
    this.getDistFilePath = utils.getDistPath(this.compilerContext, this.entryContexts);

    this.compiler.hooks.environment.tap('MiniPlugin', this.setEnvHook.bind(this));
    this.compiler.hooks.compilation.tap('MiniPlugin', this.setCompilation.bind(this));
    this.compiler.hooks.emit.tapAsync('MiniPlugin', this.setEmitHook.bind(this));
    this.compiler.hooks.additionalPass.tapAsync('MiniPlugin', this.setAdditionalPassHook.bind(this));
  }

  /**
   * 重写 webpack.watch
   */
  setEnvHook() {
    let watch = this.compiler.watch;

    // 设置子包的 cachegroup 
    this.setCacheGroup()
    this.compiler.watch = options => watch.call(this.compiler, this.compiler.options, this.watchCallBack.bind(this));
  }

  /**
   * 获取文件与打包输出目录的相对路径
   * @param {String} path 文件的绝对路径
   */
  getAesstPathHook(path) {
    return this.getDistFilePath(path);
  }

  /**
   * compilation 事件处理
   * @param {*} compilation
   */
  setCompilation(compilation) {
    /**
     * 标准输出文件名称
     */
    compilation.mainTemplate.hooks.assetPath.tap('MiniPlugin', this.getAesstPathHook.bind(this));

    /**
     * 检查是否有需要动态添加的入口文件，如果有需要重新编译
     */
    compilation.hooks.needAdditionalPass.tap('MiniPlugin', () => {
      return this._appending.length > 0;
    });

    compilation.hooks.optimizeChunks.tap('MiniPlugin', chunks => {
      for (const chunk of chunks) {
        if (chunk.hasEntryModule()) {
          // 记录模块之间依赖关系
          for (const module of chunk.getModules()) if (!module.isEntryModule()) {
            const resourcePath = module.resource
            let relPath = relative(this.compiler.context, resourcePath)
            let chunkName = chunk.name + '.js'
            if (!DEPS_MAP[relPath]) {
              DEPS_MAP[relPath] = new Set()
              DEPS_MAP[relPath].add(chunkName)
            } else {
              DEPS_MAP[relPath].add(chunkName)
            }
            module._usedModules = DEPS_MAP[relPath]
          }
        }
      }
    })
  }

  /**
   * 动态添加文件，有些自定义组件，对应的 js 文件需要作为入口文件。
   * @param {Function} callback webpack compilation callback
   */
  setAdditionalPassHook(callback) {
    if (this._appending.length > 0) {
      this.addEntrys(this.compilerContext, this._appending);
    }
    this._appending = [];
    callback();
  }

  setEmitHook(compilation, callback) {
    let ignoreEntrys = this.getIgnoreEntrys();
    let assets = compilation.assets;

    /**
     * 合并 app.json
     */
    assets['app.json'] = this.getAppJsonCode();

    console.assert(assets['app.json'], 'app.json 不应该为空')
    /**
     * 直接替换 js 代码
     */
    console.assert(assets[this.mainName + '.js'], `${join(this.mainContext, this.mainName + '.js')} 不应该不存在`)
    assets['app.js'] = assets[this.mainName + '.js'];

    /**
     * 合并 .wxss 代码到 app.wxss
     */
    assets['app.wxss'] = this.getAppWxss(compilation);


    /**
     * ext.json 如果是字符串并且存在则读取文件
     */
    if (typeof this.options.extfile === 'string') {
        assets['ext.json'] = this.getExtJson()
    }

    /**
     * 检查一些 js 文件路径
     */
    for (const file in assets) {
      let tempFile = this.getDistFilePath(file);

      if (tempFile !== file) {
        assets[tempFile] = assets[file];
        delete assets[file];
      }

      if (ignoreEntrys.indexOf(file) > -1 || /node_modules/.test(file)) {
        delete assets[file];
      }
    }
    callback();
  }

  setCacheGroup() {
    let { subPackages } = this.getAppJson()
    let cachegroups = this.compiler.options.optimization.splitChunks.cacheGroups

    function fn (module, packageRoot) {
      if (!/\.js$/.test(module.resource) || module.isEntryModule()) return
    
      let reg = new RegExp(packageRoot)
      const notOnlyInThisPackage = module._usedModules && 
        Array.from(module._usedModules).some(moduleName => !reg.test(moduleName))
      // 如果改模块在别的包也有使用，则不应该打包到该包
      return !notOnlyInThisPackage;
    }
    
    for (const { root } of subPackages) {
      let name = root.replace('/', '')
      
      cachegroups[`${name}Commons`] = {
        name: `${root}/commonchunks`,
        chunks: 'initial',
        minSize: 0,
        minChunks: 1,
        test: module => fn(module, root),
        priority: 3
      }
    }
  }
  /**
   * 输出
   * @param {*} err
   * @param {*} stat
   */
  watchCallBack(err, stat) {
    const { hash, startTime, endTime } = stat;
    const {
      warnings = [],
      errors = []
    } = stat.compilation;
    
    let ot = [{
      time: (new Date()).toLocaleTimeString().gray,
      status: !errors.length ? 'success'.green : 'fail'.red,
      watch: this.filesSet.size,
      page: this.pagesSet.size,
      component: this.componentSet.size,
      duration: (endTime - startTime + 'ms').green,
      hash
    }];

    if (warnings.length) {
      ot[0].warning = (warnings.length + '').yellow
      this.consoleMsg(warnings);
    }

    if (errors.length) {
      ot[0].error = (errors.length + '').red
      this.consoleMsg(errors)
    }

    console.table(ot);

    if (this.options.analyze) {
      for (const key in DEPS_MAP) {
        DEPS_MAP[key] = Array.from(DEPS_MAP[key])
      }
      fs.writeFileSync(join(this.compiler.context, 'analyze.json'), JSON.stringify(DEPS_MAP, null, 2), 'utf-8')
    }
  }

  consoleMsg (messages) {
    messages.forEach((err) => {
      let message = err.message.split(/\n\n|\n/);
      let mainMessage = message[0] || '';
      let lc = mainMessage.match(/\((\d+:\d+)\)/);
      lc = lc ? lc[1] : '1:1';

      console.log('Error in file', (err.module && err.module.id + ':' + lc).red);
      console.log(mainMessage.gray);
      message[1] && console.log(message[1].gray);
      message[2] && console.log(message[2].gray);
      console.log('');
    });
  }
}

module.exports = MiniPlugin;