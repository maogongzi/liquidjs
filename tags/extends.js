const Liquid = require('..');
const Promise = require('any-promise');
const lexical = Liquid.lexical;
const assert = require('../src/util/assert.js');

module.exports = function(liquid) {

    liquid.registerTag('extends', {
        parse: function(token, remainTokens){
            var match = lexical.value.exec(token.args);
            assert(match, `illegal token ${token.raw}`);

            this.layoutName = Liquid.evalValue(match[0], null);
        },

        render: function(scope, hash) {
            // should render nothing here
            return Promise.resolve('')
        }
    });

    liquid.registerTag('block', {
        parse: function(token, remainTokens){
            var match = /\w+/.exec(token.args);
            this.block = match ? match[0] : 'anonymous';

            this.tpls = [];
            var stream = liquid.parser.parseStream(remainTokens)
                .on('tag:endblock', () => stream.stop())
                .on('template', tpl => this.tpls.push(tpl))
                .on('end', () => {
                    throw new Error(`tag ${token.raw} not closed`);
                });
            stream.start();
        },

        render: function(scope){
            var register = scope.get('liquid');
            var html = register.blocks[this.block];
            // if not defined yet
            if (html === undefined) {
                return liquid.renderer.renderTemplates(this.tpls, scope)
                    .then((partial) => {
                        register.blocks[this.block] = partial;
                        return partial;
                    });
            }
            // if already defined by desendents
            else {
                register.blocks[this.block] = html;
                return Promise.resolve(html);
            }
        }
    });

};
