'use strict';

require('babel-register')({
  presets: [ 'es2015' ],
  ignore: function(filename) {
    return [
      // whitelist - must transpile these to run the tests with node 0.12
      'node_modules/broccoli-test-helper/',
      'test/helpers/'
    ].every(function(needsCompile) {
      return filename.indexOf(needsCompile) < 0;
    });
  }
});

const chai = require('chai');
const expect = chai.expect;
const chaiAsPromised = require('chai-as-promised');
const sinonChai = require('sinon-chai');
const chaiFiles = require('chai-files');
const file = chaiFiles.file;
const co = require('co');
const heimdall = require('heimdalljs');

const testHelpers = require('broccoli-test-helper');
const createTempDir = testHelpers.createTempDir;

const fixturify = require('fixturify');

chai.use(chaiAsPromised);
chai.use(sinonChai);
chai.use(chaiFiles);

const sinon = require('sinon');


const inherits = require('util').inherits;
const fs = require('fs');
const mkdirp = require('mkdirp');
const path = require('path');
const Filter = require('../');
const rimraf = require('rimraf').sync;
const os = require('os');

const ReplaceFilter = require('./helpers/replacer');
const ReplaceAsyncFilter = require('./helpers/replacer-async');
const IncompleteFilter = require('./helpers/incomplete');
const MyFilter = require('./helpers/simple');
const Rot13Filter = require('./helpers/rot13');
const Rot13AsyncFilter = require('./helpers/rot13-async');
const Builder = require('broccoli-builder').Builder;
const Entry = require('fs-tree-diff/lib/entry');

const rootFixturePath = path.join(__dirname, 'fixtures');

function fixturePath(relativePath) {
  return path.join(rootFixturePath, relativePath);
}

function millisecondsSince(time) {
  var delta = process.hrtime(time);
  return (delta[0] * 1e9 + delta[1]) / 1e6;
}

describe('Filter', function() {
   function  makeBuilder(plugin, fixturePath, prepSubject) {
    let cwd = process.cwd();
    return function() {         
        var subject = plugin.apply(undefined, arguments);
        if (prepSubject) {
          subject = prepSubject(subject);
        }
        if (!subject) {
          throw new Error('You must return the subject instance from `prepSubject`.');
        }
        process.chdir(fixturePath);
        let builder = new Builder(subject);  
         
        let build = () => {
            return builder.build()
            .then(function(tree) {
                return {
                   directory: tree.directory,
                   builder : function() {
                     return build().finally(() => {
                          process.chdir(cwd);
                    });
                   },    
                   subject: subject  
                };
            }).finally(() => {
              process.chdir(cwd);
            });
        };
        return build().finally(() => {        
            process.chdir(cwd);
        });    
    };                  
  }

  afterEach(function() {
    rimraf(path.join(rootFixturePath,'a/tmp'));
    rimraf(path.join(rootFixturePath,'b/tmp'));
    rimraf(path.join(__dirname,'tmp'));
  });

  function write(relativePath, contents, _encoding) {
    let encoding = _encoding === undefined ? 'utf8' : _encoding;

    mkdirp.sync(path.dirname(relativePath));
    fs.writeFileSync(relativePath, contents, {
      encoding
    });
  }

  it('throws if called as a function', function() {
    expect(() => Filter()).to.throw(TypeError, /abstract class and must be sub-classed/);
  });

  it('throws if called on object which does not a child class of Filter', function() {
    expect(() => Filter.call({})).to.throw(TypeError, /abstract class and must be sub-classed/);
    expect(() => Filter.call([])).to.throw(TypeError, /abstract class and must be sub-classed/);
    expect(() => Filter.call(global)).to.throw(TypeError, /abstract class and must be sub-classed/);
  });

  it('throws if base Filter class is new-ed', function() {
    expect(() => new Filter()).to.throw(TypeError, /abstract class and must be sub-classed/);
  });

  it('throws if `processString` is not implemented', function() {
    expect(() => new IncompleteFilter('.').processString('foo', 'fake_path')).to.throw(Error, /must implement/);
  });

  it('processes files with extensions included in `extensions` list by default', function() {
   let filter = MyFilter('.', { extensions: ['c', 'cc', 'js']});

    let fooEntry = Entry.fromPath('foo.c');
    let testEntry = Entry.fromPath('test.js');
    let blobEntry = Entry.fromPath('blob.cc');
    let twerpEntry = Entry.fromPath('twerp.rs');

    expect(filter.canProcessFile(fooEntry)).to.equal(true);
    expect(filter.canProcessFile(testEntry)).to.equal(true);
    expect(filter.canProcessFile(blobEntry)).to.equal(true);
    expect(filter.canProcessFile(twerpEntry)).to.equal(false);
  });

  it('getDestFilePath returns null for directories when extensions is null', function() {
    let inputPath = path.join(rootFixturePath, 'a/dir');
    let filter = MyFilter(inputPath, { extensions: null });
    filter.inputPaths = [inputPath];

    let barEntry = Entry.fromPath('a/bar/');
    let barjsEntry = Entry.fromPath('a/bar/bar.js');

    expect(filter.getDestFilePath(barEntry)).to.equal(null);
    expect(filter.getDestFilePath(barjsEntry)).to.equal('a/bar/bar.js');
  });

  it('getDestFilePath returns null for directories with matching extensions', function() {
    let inputPath = path.join(rootFixturePath, 'dir-with-extensions');
    let filter = MyFilter(inputPath, { extensions: ['js'] });
    filter.inputPaths = [inputPath];

    let loaderDirEntry = Entry.fromPath('a/loader.js/');
    let loaderFileEntry = Entry.fromPath('a/loader.js/loader.js');

    expect(filter.getDestFilePath(loaderDirEntry)).to.equal(null);
    expect(filter.getDestFilePath(loaderFileEntry)).to.equal('a/loader.js/loader.js');
  });

  it('replaces matched extension with targetExtension by default', function() {
    let filter = MyFilter('.', {
      extensions: ['c', 'cc', 'js'],
      targetExtension: 'zebra'
    });

    let fooEntry = Entry.fromPath('foo.c');
    let testEntry = Entry.fromPath('test.js');
    let blobEntry = Entry.fromPath('blob.cc');
    let twerpEntry = Entry.fromPath('twerp.rs');

    expect(filter.getDestFilePath(fooEntry)).to.equal('foo.zebra');
    expect(filter.getDestFilePath(testEntry)).to.equal('test.zebra');
    expect(filter.getDestFilePath(blobEntry)).to.equal('blob.zebra');
    expect(filter.getDestFilePath(twerpEntry)).to.equal(null);

  });

  describe('on rebuild', function() {
    let input, subject, builder;

    beforeEach(co.wrap(function* () {
      input = yield createTempDir();
      subject = new Rot13Filter(input.path());
      sinon.spy(subject, 'processString');
      sinon.spy(subject, 'postProcess');
      builder = new Builder(subject);
    }));

    afterEach(co.wrap(function* () {
      yield input.dispose();
    }));

    it('calls processString a if work is needed', co.wrap(function* () {
      input.write({
        'a': {
          'README.md': 'OMG',
          'foo.js': 'Nicest dogs in need of homes',
          'bar': {
            'bar.js': 'Dogs... who needs dogs?'
          }
        }
      });
 
      let results = yield builder.build(); 
      let resultTree = results.graph.tree;

      // first time, build everything
      expect(resultTree.processString.callCount).to.equal(3);
      expect(resultTree.postProcess.callCount).to.equal(3);

      resultTree.processString.callCount = 0;
      resultTree.postProcess.callCount = 0;

      results = yield builder.build();

      resultTree = results.graph.tree;

      // rebuild, but no changes (build nothing);
      expect(resultTree.processString.callCount).to.equal(0);
      expect(resultTree.postProcess.callCount).to.equal(0);

      input.write({
        'a': {
          'README.md': 'OMG 2'
        }
      });

      results = yield builder.build();
      resultTree = results.graph.tree;
      // rebuild 1 file
      expect(resultTree.processString.callCount).to.equal(1);
      expect(resultTree.postProcess.callCount).to.equal(1);

      resultTree.postProcess.callCount = 0;
      resultTree.processString.callCount = 0;

      input.write({
        'a': { 'README.md': null }
      });

      results = yield builder.build();
      resultTree = results.graph.tree;
      // rebuild 0 files
      expect(resultTree.processString.callCount).to.equal(0);
      expect(resultTree.postProcess.callCount).to.equal(0);
    }));

    describe('mid build failure', function() {
      let input;
      let output;
      let subject;
      let builder;

      function Plugin(inputNode, options) {
        if (!this) {
          return new Plugin(inputNode, options);
        }

        this.shouldFail = true;
        Filter.call(this, inputNode, options);
      }

      inherits(Plugin, Filter);

      Plugin.prototype.processString = function(content) {
        let shouldFail = this.shouldFail;
        this.shouldFail = false;
        if (shouldFail) {
          throw new Error('first build happens to fail');
        }

        return content;
      };

      beforeEach(co.wrap(function* () {
        input = yield createTempDir();
        subject = new Plugin(input.path());
        builder = new Builder(subject);
      }));

      afterEach(co.wrap(function* () {
        yield input.dispose();
      }));

      //TODO: Fix the builder to make it work
      it('works', co.wrap(function* () {
        input.write({
          'index.js': 'console.log("hi")'
        });

        let didFail = false;
        try {
          output = yield builder.build();
        } catch(error) {
          didFail = true;
          expect(error.message).to.contain('first build happens to fail');
        }
        expect(didFail).to.eql(true);
        expect(output).to.be.undefined;

        output = yield builder.build();
        
         expect(fixturify.readSync(output.graph.tree.out._root)).to.deep.equal({
          'index1.js': 'console.log("hi")',
        });
      }));
    });

    describe('build failures - async', function() {
    
      let input;
      let output;
      let subject;

      class Plugin extends Filter {
        constructor(inputTree, options) {
          super(inputTree, options);
          this.shouldFail = true;
        }

        processString(content) {
          // every other file fails to build
          let shouldFail = this.shouldFail;
          this.shouldFail = !this.shouldFail;

          return new Promise((resolve, reject) => {
            setTimeout(() => {
              if (shouldFail) {
                reject('file failed for some reason');
              }
              else {
                resolve(content);
              }
            }, 50);
          });
        }
      }

      beforeEach(co.wrap(function* () {
        process.env.JOBS = '4';
        input = yield createTempDir();
        subject = new Plugin(input.path(), { async:true });
        output = new Builder(subject);
      }));

      afterEach(co.wrap(function* () {
        delete process.env.JOBS;
        yield input.dispose();
      }));

      it('completes all pending work before returning', co.wrap(function* () {
        input.write({
          'index0.js': 'console.log("hi")',
          'index1.js': 'console.log("hi")',
          'index2.js': 'console.log("hi")',
          'index3.js': 'console.log("hi")',
        });

        let didFail = false;
        try {
          yield output.build();
        } catch(error) {
          didFail = true;
          expect(error.message).to.contain('file failed for some reason', 'error message text should match');
        }
        expect(didFail).to.eql(true, 'build should fail');
        //should write the files that did not fail
        expect(fixturify.readSync(output.tree.out._root)).to.deep.equal({
          'index1.js': 'console.log("hi")',
          'index3.js': 'console.log("hi")',
        });
      }));
    });

    describe('with extensions & targetExtension', function() {
      it('calls processString if work is needed', co.wrap(function* () {
       
        let builder = makeBuilder(Rot13Filter, fixturePath('a'), awk => {
          sinon.spy(awk, 'processString');
          return awk;
        });
        let originalFileContent;
        let originalFilePath;
        let originalJSFileContent;
        let originalJSFilePath;
        let someDirPath;
        let awk;

        try {
          let results = yield builder('dir', {
            extensions: ['js'],
            targetExtension: 'OMG'
          });
        
          awk = results.subject;

          // first time, build everything
          expect(awk.processString.callCount).to.equal(2);
          awk.processString.callCount = 0;   

          results = yield results.builder();
          awk = results.subject;

          // rebuild, but no changes (build nothing);
         expect(awk.processString.callCount).to.equal(0);
         originalFilePath = awk.inputPaths[0] + '/a/README.md';
         originalFileContent = fs.readFileSync(originalFilePath);
         fs.writeFileSync(originalFilePath, 'OMG');

         expect(file(results.directory + '/a/foo.OMG')).to.exist;

         results = yield results.builder();
         awk = results.subject;

          // rebuild 0 files, changed file does not match extensions
          expect(awk.processString.callCount).to.equal(0);
          awk.processString.callCount = 0;
          fs.unlinkSync(originalFilePath);

          results = yield results.builder();
          awk = results.subject;

          // rebuild 0 files
          expect(awk.processString.callCount).to.equal(0);
          someDirPath = awk.inputPaths[0] + '/fooo/';
          fs.mkdirSync(someDirPath);

          results = yield results.builder();
          awk = results.subject;

          // rebuild, but no changes (build nothing);
          expect(awk.processString.callCount).to.equal(0);

          originalJSFilePath = 'a/foo.js';

          originalJSFilePath = awk.inputPaths[0] + '/a/foo.js';
          originalJSFileContent = fs.readFileSync(originalJSFilePath);
          fs.writeFileSync(originalJSFilePath, 'OMG');
          
          results = yield results.builder();
          awk = results.subject;

          // rebuild, but no changes (build nothing);
          expect(awk.processString.callCount).to.equal(1);
          expect(fs.readFileSync(results.directory + '/a/foo.OMG', 'UTF-8')).to.eql('BZT');

          yield results.builder();

        } finally {
          try {
            fs.writeFileSync(originalFilePath,  originalFileContent);
          } catch(e) { }
          try {
            fs.rmdirSync(someDirPath);

          } catch(e) { }

          try {

            fs.writeFileSync(originalJSFilePath, originalJSFileContent);
          } catch(e) { }
        }
      }));
    });


    it('handles renames', co.wrap(function* () {
       let builder = makeBuilder(Rot13Filter, fixturePath('a'), awk => {
        sinon.spy(awk, 'processString');
        return awk;
      });

      let filePathPrevious;
      let filePathNext;

      try {
         let results = yield builder('dir', {
          extensions: ['md'],
          targetExtension: ['foo.md']
        });

        let awk = results.subject;

        // first time, build everything
        expect(awk.processString.callCount).to.equal(1);
        awk.processString.callCount = 0;

        filePathPrevious = awk.inputPaths[0] + '/a/README.md';
        filePathNext = awk.inputPaths[0] + '/a/README-renamed.md';

        fs.writeFileSync(filePathNext, fs.readFileSync(filePathPrevious));
        fs.unlinkSync(filePathPrevious);

        results = yield results.builder();

        let files = Array.from(results.subject.out._entries).map(entry =>  entry.relativePath);
         
          expect(files).to.eql([
          'a',
          'a/README-renamed.foo.md',
          'a/bar',
          'a/bar/bar.js',
          'a/foo.js'
        ]);

      } finally {
        fs.writeFileSync(filePathPrevious, fs.readFileSync(filePathNext));
        fs.unlinkSync(filePathNext);
      }
    }));

    it('preserves mtimes if neither content did not actually change', co.wrap(function* () {
      let builder = makeBuilder(Rot13Filter, fixturePath('a'), awk => {
        sinon.spy(awk, 'processString');
        return awk;
      });

      let stat;
      let filePath;

       let results = yield builder('dir', {
        extensions: ['md']
      });
       let awk = results.subject;

      // first time, build everything
      expect(awk.processString.callCount).to.equal(1);
      awk.processString.callCount = 0;
      filePath = awk.inputPaths[0] + '/a/README.md';

      fs.writeFileSync(filePath, fs.readFileSync(filePath));
      stat = fs.statSync(filePath);

       results = yield results.builder();

      let afterRebuildStat = fs.statSync(filePath);

      expect(awk.processString).to.have.been.calledOnce;
      // rebuild changed file

     expect(awk.processString).to.have.been.calledWith('Nicest cats in need of homes',  'a/README.md');
      // although file was "rebuilt", no observable difference can be observed
      expect(stat.mode).to.equal(afterRebuildStat.mode);
      expect(stat.size).to.equal(afterRebuildStat.size);
      expect(stat.mtime.getTime()).to.equal(afterRebuildStat.mtime.getTime());
    }));
  });

  it('targetExtension work for no extensions', co.wrap(function* () {
     
    let builder = makeBuilder(Rot13Filter, fixturePath('a'), awk => {
      sinon.spy(awk, 'processString');
      return awk;
    });

    let results = yield builder('dir', {
      targetExtension: 'foo',
      extensions: []
    });

    let awk = results.subject;

    expect(file(results.directory + '/a/README.md')).to.equal('Nicest cats in need of homes');
    expect(file(results.directory + '/a/foo.js')).to.equal('Nicest dogs in need of homes');

    expect(awk.processString.callCount).to.equal(0);
  }));

  it('targetExtension work for single extensions', co.wrap(function* () {
    let builder = makeBuilder(Rot13Filter, fixturePath('a'), awk => {
      sinon.spy(awk, 'processString');
      return awk;
    });

    let results = yield builder('dir', {
      targetExtension: 'foo',
      extensions: ['js']
    });

    expect(file(results.directory + '/a/README.md')).to.equal('Nicest cats in need of homes');
    expect(file(results.directory + '/a/foo.foo')).to.equal('Avprfg qbtf va arrq bs ubzrf');

    expect(results.subject.processString.callCount).to.equal(2);
  }));

  it('targetExtension work for multiple extensions', co.wrap(function* () {
    let builder = makeBuilder(Rot13Filter, fixturePath('a'), awk => {
      sinon.spy(awk, 'processString');
      return awk;
    });

    let results = yield builder('dir', {
      targetExtension: 'foo',
      extensions: ['js','md']
    });

    expect(file(results.directory + '/a/README.foo')).to.equal('Avprfg pngf va arrq bs ubzrf');
    expect(file(results.directory + '/a/foo.foo')).to.equal('Avprfg qbtf va arrq bs ubzrf');

    expect(results.subject.processString.callCount).to.equal(3);
  }));

  
  it('targetExtension work for multiple extensions - async', co.wrap(function* () {
    this.timeout(30*1000); // takes >10s when run with node 0.12
        
    let subject = new Rot13AsyncFilter(fixturePath('a'), {
      targetExtension: 'foo',
      extensions: ['js', 'md'],
      async: true,
    });


    let output = new Builder(subject);
    let results =  yield output.build();

    expect(file(results.directory + '/dir/a/README.foo')).to.equal('Avprfg pngf va arrq bs ubzrf');
    expect(file(results.directory + '/dir/a/foo.foo')).to.equal('Avprfg qbtf va arrq bs ubzrf');

  }));

  it('handles directories that older versions of walkSync do not sort lexicographically', co.wrap(function* () {
    let builder = makeBuilder(Rot13Filter, fixturePath('b'), awk => {
      sinon.spy(awk, 'processString');
      return awk;
    });

    let results = yield builder('dir', {
      targetExtension: 'foo',
      extensions: ['js']
    });

    expect(file(results.directory + '/foo.md')).to.equal('Nicest cats in need of homes');
    expect(file(results.directory + '/foo/bar.foo')).to.equal('Avprfg qbtf va arrq bs ubzrf');

    expect(results.subject.processString.callCount).to.equal(1);
  }));

  it('should processString when canProcessFile returns true', co.wrap(function* () {
    let builder = makeBuilder(ReplaceFilter, fixturePath('a'), awk => {
      sinon.spy(awk, 'processString');
      return awk;
    });

    let results = yield builder('dir', {
      glob: '**/*.md',
      search: 'dogs',
      replace: 'cats',
      targetExtension: 'foo'
    });

     let awk = results.subject;

    expect(file(results.directory + '/a/README.md')).to.equal('Nicest cats in need of homes');
    expect(file(results.directory + '/a/foo.js')).to.equal('Nicest dogs in need of homes');
    expect(awk.processString.callCount).to.equal(1);
  }));

  it('should processString and postProcess', co.wrap(function* () {
     let builder = makeBuilder(ReplaceFilter, fixturePath('a'), awk => {
      awk.postProcess = function(object) {
        expect(object.output).to.exist;
        object.output = object.output + 0x00 + 'POST_PROCESSED!!';
        return object;
      };

      sinon.spy(awk, 'processString');
      sinon.spy(awk, 'postProcess');

      return awk;
    });

    let results = yield builder('dir', {
      search: 'dogs',
      replace: 'cats'
    });
     let awk = results.subject;

    expect(file(results.directory + '/a/README.md')).to.equal('Nicest cats in need of homes' + 0x00 + 'POST_PROCESSED!!');
    expect(file(results.directory + '/a/foo.js')).to.equal('Nicest cats in need of homes' + 0x00 + 'POST_PROCESSED!!');

    expect(awk.processString.callCount).to.equal(3);
    expect(awk.postProcess.callCount).to.equal(3);
  }));

  it('complains if canProcessFile is true but getDestFilePath is null', function() {
    let builder = makeBuilder(ReplaceFilter, fixturePath('a'), awk => {
      awk.canProcessFile = function() {
        // We cannot return `true` here unless `getDestFilePath` also returns
        // a path
        return true;
      };
      return awk;
    });

    return expect(builder('dir', {
      glob: '**/*.md',
      search: 'dogs',
      replace: 'cats'
    })).to.eventually.be.rejectedWith(Error, /getDestFilePath.* is null/);
  });

  it('purges cache', co.wrap(function *() {
    let builder = makeBuilder(ReplaceFilter, fixturePath('a'), awk => {
      return awk;
    });

    let fileForRemoval = path.join(fixturePath('a'), 'dir', 'a', 'README.md');

    let results = yield builder('dir', {
      glob: '**/*.md',
      search: 'dogs',
      replace: 'cats'
    });

    expect(file(fileForRemoval)).to.exist;
    rimraf(fileForRemoval);

    expect(file(fileForRemoval)).to.not.exist;
    expect(file(results.directory + '/a/README.md')).to.exist;

     results = yield results.builder();

    expect(file(results.directory + '/a/README.md')).to.not.exist;
    expect(file(fileForRemoval)).to.not.exist;

    write(fileForRemoval, 'Nicest cats in need of homes');
    expect(file(fileForRemoval)).to.exist;

    results = yield results.builder();

    expect(file(results.directory + '/a/foo.js')).to.exist;
  }));

  describe('stale entries', function() {
    let fileForChange = path.join(fixturePath('a'), 'dir', 'a', 'README.md');
    
    afterEach(function() {
      write(fileForChange, 'Nicest cats in need of homes');
    });

    it('replaces stale entries', co.wrap(function* () {
      let builder = makeBuilder(ReplaceFilter, fixturePath('a'), awk => awk);

      let results = yield builder('dir', {
        glob: '**/*.md',
        search: 'dogs',
        replace: 'cats'
      });

      expect(file(fileForChange)).to.exist;
      write(fileForChange, 'such changes');
      expect(file(fileForChange)).to.exist;

      results = yield results.builder();

      expect(file(fileForChange)).to.exist;
      write(fileForChange, 'such changes');
      expect(file(fileForChange)).to.exist;
    }));

    it('replaces stale entries - async', co.wrap(function* () {

      let subject = new ReplaceAsyncFilter(fixturePath('a'), {
        glob: '**/*.md',
        search: 'cats',
        replace: 'dogs',
        async: true,
      });

      let builder = new Builder(subject);
      let output = yield builder.build();   

      expect(file(output.directory + '/dir/a/README.md')).to.equal('Nicest dogs in need of homes');

      expect(file(fileForChange)).to.exist;
      write(fileForChange, 'such changes');
      expect(file(fileForChange)).to.exist;

      output = yield builder.build();

      expect(file(output.directory + '/dir/a/README.md')).to.equal('such changes');
      }));

    });

  it('does not overwrite core options if they are not present', function() {
    function F(inputTree, options) {
      Filter.call(this, inputTree, options);
    }

    inherits(F, Filter);

    F.prototype.extensions = ['js', 'rs'];
    F.prototype.targetExtension = 'glob';
    F.prototype.inputEncoding = 'latin1';
    F.prototype.outputEncoding = 'shift-jis';

    expect(new F('.').extensions).to.eql(['js', 'rs']);
    expect(new F('.').targetExtension).to.equal('glob');
    expect(new F('.').inputEncoding).to.equal('latin1');
    expect(new F('.').outputEncoding).to.equal('shift-jis');

    expect(new F('.', {
      extensions: ['x']
    }).extensions).to.eql(['x']);

    expect(new F('.', {
      targetExtension: 'c'
    }).targetExtension).to.equal('c');

    expect(new F('.', {
      inputEncoding: 'utf8'
    }).inputEncoding).to.equal('utf8');

    expect(new F('.', {
      outputEncoding: 'utf8'
    }).outputEncoding).to.equal('utf8');
  });

  it('reports heimdall timing correctly for async work', co.wrap(function* () {
    heimdall._reset();
    
    let subject = new Rot13AsyncFilter(fixturePath('a'), {
      targetExtension: 'foo',
      extensions: ['js', 'md'],
      async: true,
    });

    //rimraf(fixturePath('a/tmp'));
    yield new Builder(subject).build();

    var applyPatchesNode = heimdall.toJSON().nodes.filter(elem => elem.id.name === 'applyPatches - persistent filter')[0];

    var selfTime = applyPatchesNode.stats.time.self / (1000 * 1000); // convert to ms
    expect(selfTime).to.be.above(50, 'reported time should include the 50ms timeout in Rot13AsyncFilter');
  }));

  describe('persistent cache', function() {
    function F(inputTree, options) {
      Filter.call(this, inputTree, options);
    }

    inherits(F, Filter);

    F.prototype.baseDir = function() {
      return path.join(__dirname, '../');
    };

    beforeEach(function() {
      this.originalCacheRoot = process.env.BROCCOLI_PERSISTENT_FILTER_CACHE_ROOT;
    });

    afterEach(function() {
      if (this.originalCacheRoot) {
        process.env.BROCCOLI_PERSISTENT_FILTER_CACHE_ROOT = this.originalCacheRoot;
      } else {
        delete process.env.BROCCOLI_PERSISTENT_FILTER_CACHE_ROOT;
      }
    });

    it('initializes cache', function() {
      this.timeout(15*1000); // takes >5s when run with node 0.12
      let f = new F(fixturePath('a'), {
        persist: true
      });
      // TODO: we should just deal in observable differences, not reaching into private state
      expect(f.processor.processor._cache).to.be.ok;
    });

    it('initializes cache using ENV variable if present', function() {
      process.env.BROCCOLI_PERSISTENT_FILTER_CACHE_ROOT = path.join(os.tmpdir(),
                                                                    'foo-bar-baz-testing-123');

      let f = new F(fixturePath('a'), {
        persist: true
      });

      // TODO: we should just deal in observable differences, not reaching into private state
      expect(f.processor.processor._cache.tmpdir).
        to.be.equal(process.env.BROCCOLI_PERSISTENT_FILTER_CACHE_ROOT);
    });

    it('throws an UnimplementedException if the abstract `baseDir` implementation is used', function() {

      function F(inputTree, options) {
        Filter.call(this, inputTree, options);
      }

      inherits(F, Filter);

      expect(function() {
        new F(fixturePath('a'), { persist: true });
      }).to.throw(/Filter must implement prototype.baseDir/);
    });

    it('`cacheKeyProcessString` return correct first level file cache', function() {
      let f = new F(fixturePath('a'), { persist: true });

      expect(f.cacheKeyProcessString('foo-bar-baz', 'relative-path')).
        to.eql('272ebac734fa8949ba2aa803f332ec5b');
    });

    it('properly reads the file tree', co.wrap(function* () {
      let builder = makeBuilder(ReplaceFilter, fixturePath('a'), awk => awk);

      let results = yield builder('dir', {
        persist: true,
        glob: '**/*.md',
        search: 'dogs',
        replace: 'cats'
      });
      let awk = results.subject;

      let files = Array.from(awk.out._entries).map(entry =>  entry.relativePath);
         
        expect(files).to.deep.eql([
        'a',
        'a/README.md',
        'a/bar',
        'a/bar/bar.js',
        'a/foo.js'
      ]);

    }));

    it('calls postProcess for persistent cache hits (work is not needed)', co.wrap(function* () {
      process.env.BROCCOLI_PERSISTENT_FILTER_CACHE_ROOT = path.join(os.tmpdir(),
        'process-cache-string-tests');
      rimraf(process.env.BROCCOLI_PERSISTENT_FILTER_CACHE_ROOT);

      let builder = makeBuilder(ReplaceFilter, fixturePath('a'), awk => {
        awk.postProcess = function(result) {
          expect(result.output).to.exist;
          return result;
        };
        sinon.spy(awk, 'processString');
        sinon.spy(awk, 'postProcess');
        return awk;
      });
      
     let results = yield builder('dir', { persist: true });
     let awk = results.subject;

      // first time, build everything
      expect(awk.processString.callCount).to.equal(3);
      expect(awk.postProcess.callCount).to.equal(3);

      //results = yield  builder('dir', { persist: true });
      awk.processString.callCount = 0;

      results =  yield results.builder();

      // second instance, hits cache
      expect(awk.processString.callCount).to.equal(0);
      expect(awk.postProcess.callCount).to.equal(3);
    }));

    it('postProcess return value is not used', co.wrap(function* () {
      process.env.BROCCOLI_PERSISTENT_FILTER_CACHE_ROOT = path.join(os.tmpdir(),
        'process-cache-string-tests');
      rimraf(process.env.BROCCOLI_PERSISTENT_FILTER_CACHE_ROOT);

      let builder = makeBuilder(ReplaceFilter, fixturePath('a'), awk => {
        awk.postProcess = function(result) {
          expect(result.output).to.exist;

          result.output = result.output + 0x00 + 'POST_PROCESSED!!';

          return Promise.resolve(result);
        };

        return awk;
      });

      yield builder('dir', { persist: true });
      // do nothing, just kicked off to warm the persistent cache
      let results = yield builder('dir', { persist: true });
      expect(file(results.directory + '/a/foo.js')).to.equal('Nicest dogs in need of homes' + 0x00 + 'POST_PROCESSED!!');
    }));
  });

  describe('processFile', function() {
    let input, subject, output;

    beforeEach(co.wrap(function* () {
      sinon.spy(fs, 'mkdirSync');
      sinon.spy(fs, 'writeFileSync');

      input = yield createTempDir();
      subject = new ReplaceFilter(input.path(), {
        search: 'dogs',
        replace: 'cats'
      });

      sinon.spy(subject, 'processString');
      sinon.spy(subject, 'postProcess');

      output = new Builder(subject);
    }));

    afterEach(co.wrap(function* () {
      fs.mkdirSync.restore();
      fs.writeFileSync.restore();
      yield input.dispose();
    }));

    it('should work if `processString` returns a Promise', co.wrap(function* () {
      input.write({
        'foo.js': 'a promise is a promise'
      });

      yield output.build();

      expect(fixturify.readSync(output.tree.out._root)).to.deep.equal({
        'foo.js': 'a promise is a promise'
      });

    }));

    it('does not effect the current cwd', co.wrap(function* () {
      input.write({
        'a': {
          'foo.js': 'Nicest dogs in need of homes'
        }
      });

      yield output.build();

      let cwd = process.cwd();
      let a = path.join(cwd, 'a');

      expect(fs.mkdirSync.calledWith(a, 493)).to.eql(false);
      expect(fs.mkdirSync.calledWith(path.join(a, 'bar'), 493)).to.eql(false);

      expect(fs.writeFileSync.calledWith(path.join(cwd, 'a', 'foo.js'),
        'Nicest dogs in need of homes')).to.eql(false);

      yield output.build();

      expect(fs.writeFileSync.calledWith(path.join(cwd, 'a', 'foo.js'),
        'Nicest dogs in need of homes')).to.eql(false);
    }));
  });

  describe('concurrency', function() {
    afterEach(function() {
      delete process.env.JOBS;
    });

    it('sets concurrency using environment variable', function() {
      process.env.JOBS = '12';
      let filter = MyFilter('.', {});
      expect(filter.concurrency).to.equal(12);
    });

    it('sets concurrency using options.concurrency', function() {
      process.env.JOBS = '12';
      let filter = MyFilter('.', { concurrency: 15 });
      expect(filter.concurrency).to.equal(15);
    });

    describe('CPU detection', function() {
      afterEach(function() {
        os.cpus.restore();
      });

      it('should set to detected CPUs - 1', function() {
        sinon.stub(os, 'cpus').callsFake(() => ['cpu0', 'cpu1', 'cpu2']);
        let filter = MyFilter('.', {});
        expect(filter.concurrency).to.equal(2);
      });

      it('should have a min of 1', function() {
        sinon.stub(os, 'cpus').callsFake(() => []);
        let filter = MyFilter('.', {});
        expect(filter.concurrency).to.equal(1);
      });
    });
  });
});

describe('throttling', function() {

  let input;
  let output;
  let subject;

  class Plugin extends Filter {
    constructor(inputTree, options) {
      super(inputTree, options);
      this.shouldFail = true;
    }

    processString(content) {
      return new Promise((resolve) => {
        setTimeout(() => {
          resolve(content);
        }, 100);
      });
    }
  }

  beforeEach(co.wrap(function* () {
    input = yield createTempDir();
    input.write({
      'index0.js': 'console.log("hi")',
      'index1.js': 'console.log("hi")',
      'index2.js': 'console.log("hi")',
      'index3.js': 'console.log("hi")',
    });
  }));

  afterEach(co.wrap(function* () {
    delete process.env.JOBS;

    expect(fixturify.readSync(output.tree.out._root)).to.deep.equal({
      'index0.js': 'console.log("hi")',
      'index1.js': 'console.log("hi")',
      'index2.js': 'console.log("hi")',
      'index3.js': 'console.log("hi")',
    });

    yield input.dispose();
  }));

  it('throttles operations to 1 concurrent job', co.wrap(function* () {
    process.env.JOBS = '1';
    subject = new Plugin(input.path(), { async:true });
    output = new Builder(subject);
    expect(subject.concurrency).to.equal(1);
    var startTime = process.hrtime();
    yield output.build();

    expect(millisecondsSince(startTime)).to.be.above(400, '4 groups of 1 file each, taking 100ms each, should take at least 400ms');
  }));

  it('throttles operations to 2 concurrent jobs', co.wrap(function* () {
    process.env.JOBS = '2';
    subject = new Plugin(input.path(), { async:true });
    output =  new Builder(subject);
    expect(subject.concurrency).to.equal(2);

    var startTime = process.hrtime();

    yield output.build();

    expect(millisecondsSince(startTime)).to.be.above(200, '2 groups of 2 files each, taking 100ms each, should take at least 200ms');
  }));

  it('throttles operations to 4 concurrent jobs', co.wrap(function* () {
    process.env.JOBS = '4';
    subject = new Plugin(input.path(), { async:true });
    output = new Builder(subject);
    expect(subject.concurrency).to.equal(4);

    var startTime = process.hrtime();

    yield output.build();

    expect(millisecondsSince(startTime)).to.be.above(100, '1 group of all 4 files, taking 100ms each, should take at least 100ms');
    expect(millisecondsSince(startTime)).to.be.below(200, 'all 4 jobs running concurrently in 1 group should finish in about 100ms');
  }));
});
