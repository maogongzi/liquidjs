const fs = require('fs')
const Scope = require('./src/scope')
const _ = require('./src/util/underscore.js')
const assert = require('./src/util/assert.js')
const tokenizer = require('./src/tokenizer.js')
const statFileAsync = require('./src/util/fs.js').statFileAsync
const readFileAsync = require('./src/util/fs.js').readFileAsync
const path = require('path')
const Render = require('./src/render.js')
const lexical = require('./src/lexical.js')
const Tag = require('./src/tag.js')
const Filter = require('./src/filter.js')
const Parser = require('./src/parser')
const Syntax = require('./src/syntax.js')
const tags = require('./tags')
const filters = require('./filters')
const Promise = require('any-promise')
const anySeries = require('./src/util/promise.js').anySeries
const Errors = require('./src/util/error.js')

var _engine = {
  init: function (tag, filter, options) {
    if (options.cache) {
      this.cache = {}
    }
    this.options = options
    this.tag = tag
    this.filter = filter
    this.parser = Parser(tag, filter)
    this.renderer = Render()

    tags(this)
    filters(this)

    return this
  },
  parse: function (html, filepath) {
    let layoutName = null;
    let currentTokens = tokenizer.parse(html, filepath, this.options);
    let layoutTokens = [currentTokens];

    // has a layout?
    if (
        currentTokens[0].type === 'tag' &&
        currentTokens[0].name === 'extends'
    ) {
      let extendsTag = this.parser.parse([currentTokens[0]]);

      layoutName = extendsTag[0].tagImpl.layoutName;
      // remove extends tag from token list
      currentTokens.shift();
    }

    while (layoutName) {
        let superTokens = this.parseTokensSync(layoutName);

        // TODO: check whether the 'extends' tag is the first tag,
        // throw an error if it's not.
        if (
            superTokens[0].type === 'tag' &&
            superTokens[0].name === 'extends'
        ) {
            let extendsTag = this.parser.parse([superTokens[0]]);

            layoutName = extendsTag[0].tagImpl.layoutName;
            // remove 'extends' tag
            superTokens.shift();
            layoutTokens.push(superTokens);
        } else {
            // no more super layouts!
            layoutName = null;
            layoutTokens.push(superTokens);
        }
    }

    // parse the tokens right away so that we have all blocks built.
    let parsedLayouts = layoutTokens.map((tkns) => {
      return this.parser.parse(tkns);
    });

    // there aren't any layouts, return current parsed tokens immediately
    if (parsedLayouts.length === 1) {
      return parsedLayouts[0];
    }
    // merge block in a left-to-right order and handle 'block.super' references
    else {
      let blocksMap = {};

// try {

      for (let i=0; i < parsedLayouts.length; i++) {
        parsedLayouts[i] = parsedLayouts[i].map((leftTpl) => {
          // is a block? (otherwise will be simply ignored)
          if (leftTpl.type === 'tag' && leftTpl.name === 'block') {
            leftTpl = this.replaceNestedBlocks(leftTpl, blocksMap);
          }

          return leftTpl;
        });
      }

// } catch(e) {
//   console.log(e)
// }

      // return the combined parsed template chunks
      // console.log(parsedLayouts[0])
      return parsedLayouts[parsedLayouts.length - 1];
    }
  },

  replaceNestedBlocks(leftTpl, blocksMap) {
    // block not registered
    if (!blocksMap[leftTpl.tagImpl.block]) {
      blocksMap[leftTpl.tagImpl.block] = leftTpl;
    }
    // TODO: detect same name blocks in same template.
    // block from parent layout
    else {
      let childBlock = blocksMap[leftTpl.tagImpl.block];

      // has a block.super reference?
      let superRefIdx = childBlock.tagImpl.tpls.findIndex((ctpl) => {
        return ctpl.type === 'output' && ctpl.initial === 'block.super';
      });

      // replace and override parent block
      if (superRefIdx > -1) {
        // first merge parent tpls into child tpls;
        childBlock.tagImpl.tpls.splice(
          superRefIdx, 1, ...leftTpl.tagImpl.tpls);
      }
      // then replace parent tpls by merged tpls;
      leftTpl.tagImpl.tpls = childBlock.tagImpl.tpls;
    }

    leftTpl.tagImpl.tpls = leftTpl.tagImpl.tpls.map((cLeftTpl) => {
      // is a block? (otherwise will be simply ignored)
      if (cLeftTpl.type === 'tag' && cLeftTpl.name === 'block') {
        cLeftTpl = this.replaceNestedBlocks(cLeftTpl, blocksMap);
      }

      return cLeftTpl;
    });

    return leftTpl;
  },

  render: function (tpl, ctx, opts) {
    opts = _.assign({}, this.options, opts)
    var scope = Scope.factory(ctx, opts)
    return this.renderer.renderTemplates(tpl, scope)
  },
  parseAndRender: function (html, ctx, opts) {
    return Promise.resolve()
      .then(() => this.parse(html))
      .then(tpl => this.render(tpl, ctx, opts))
  },
  renderFile: function (filepath, ctx, opts) {
    opts = _.assign({}, opts)
    return this.getTemplate(filepath, opts.root)
      .then(templates => this.render(templates, ctx, opts))
  },
  evalOutput: function (str, scope) {
    var tpl = this.parser.parseOutput(str.trim())
    return this.renderer.evalOutput(tpl, scope)
  },
  registerFilter: function (name, filter) {
    return this.filter.register(name, filter)
  },
  registerTag: function (name, tag) {
    return this.tag.register(name, tag)
  },
  lookup: function (filepath, root) {
    root = this.options.root.concat(root || [])
    root = _.uniq(root)
    var paths = root.map(root => path.resolve(root, filepath))
    return anySeries(paths, path => statFileAsync(path).then(() => path))
      .catch((e) => {
        if (e.code === 'ENOENT') {
          e.message = `Failed to lookup ${filepath} in: ${root}`
        }
        throw e
      })
  },

  // read templates from file system synchronizely.
  getTemplateSync: function (filepath, root) {    
    // we've found the template file, prepare to parse it.
    // cache enabled?
    if (this.options.cache && this.cache[filepath]) {
      return this.cache[filepath];
    }

    let tokens = this.parseTokensSync(filepath, root);
    let tpls = this.parser.parse(tokens);
    
    // need to be cached?
    if (this.options.cache) {
      this.cache[filepath] = tpls;
    }

    return tpls;
  },

  // tokenize template file synchonizely.
  parseTokensSync(filepath, root) {
    let html = this.getTemplateHTMLSync(filepath, root);

    return tokenizer.parse(html, filepath, this.options);
  },

  getTemplateHTMLSync(filepath, root) {
    if (!path.extname(filepath)) {
      filepath += this.options.extname
    }

    root = this.options.root.concat(root || []);
    root = _.uniq(root);

    let possiblePaths = root.map(root => path.resolve(root, filepath));
    // first mark it as null, if later we find one available path,
    // we'll use it then.
    let resolvedPath = null;

    // check all possible template paths
    for (let i=0; i< possiblePaths.length; i++) {
      try {
        fs.accessSync(possiblePaths[i]);
        resolvedPath = possiblePaths[i];

        // we've found one available path, return and use it immediately
        break;
      } catch (e) {
        // NO-OP (nothing to do here, continue to check the next path)
      }
    }

    // template not found, throw an error
    if (!resolvedPath) {
      throw {
        code: 'ENOENT',
        message: `template ${resolvedPath} not found`
      }
    }

    return fs.readFileSync(resolvedPath, 'utf8');
  },

  getTemplate: function (filepath, root) {
    if (!path.extname(filepath)) {
      filepath += this.options.extname
    }
    return this
      .lookup(filepath, root)
      .then(filepath => {
        if (this.options.cache) {
          var tpl = this.cache[filepath]
          if (tpl) {
            return Promise.resolve(tpl)
          }
          return readFileAsync(filepath)
            .then(str => this.parse(str))
            .then(tpl => (this.cache[filepath] = tpl))
        } else {
          return readFileAsync(filepath).then(str => this.parse(str, filepath))
        }
      })
  },
  express: function (opts) {
    opts = opts || {}
    var self = this
    return function (filepath, ctx, callback) {
      assert(Array.isArray(this.root) || _.isString(this.root),
        'illegal views root, are you using express.js?')
      opts.root = this.root
      self.renderFile(filepath, ctx, opts)
        .then(html => callback(null, html))
        .catch(e => callback(e))
    }
  }
}

function factory (options) {
  options = _.assign({
    root: ['.'],
    cache: false,
    extname: '.liquid',
    trim_right: false,
    trim_left: false,
    strict_filters: false,
    strict_variables: false
  }, options)
  options.root = normalizeStringArray(options.root)

  var engine = Object.create(_engine)
  engine.init(Tag(), Filter(options), options)
  return engine
}

function normalizeStringArray (value) {
  if (Array.isArray(value)) return value
  if (_.isString(value)) return [value]
  return []
}

factory.lexical = lexical
factory.isTruthy = Syntax.isTruthy
factory.isFalsy = Syntax.isFalsy
factory.evalExp = Syntax.evalExp
factory.evalValue = Syntax.evalValue
factory.Types = {
  ParseError: Errors.ParseError,
  TokenizationEroor: Errors.TokenizationError,
  RenderBreakError: Errors.RenderBreakError,
  AssertionError: Errors.AssertionError
}

module.exports = factory
