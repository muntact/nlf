// Idea to replace find.
"strict";

var _ = require('lodash');
var readInstalled = require('read-installed');
var compareModuleNames = require('./lib/compare-module-names');
var Module = require('./lib/module');
var path = require('path');
var fs = require('fs');
var glob = require('glob-all');
var FileSource = require('./lib/file-source');
var PackageSource = require('./lib/package-source');
var csvFormatter = require('./lib/formatters/csv');
var standardFormatter = require('./lib/formatters/standard');
var LicenseCollection = require('./lib/license-collection');
var licenseFind = require('./lib/license-find');

var options = {};
// TODO: deal with number = Infinity.
options.depth = 20;
options.production = false;
// dedupe options:
// options.dedupe = {
//   // dedupe module by repository?
//   byRepository: true,
// }

// readInstalled(__dirname, function(err, data) {
readInstalled('/Users/murrayl/projects/ohw-web-components/ohw-conditions-card', function(err, data) {
  // make the array to hold module 'dirs'
  var modules = Array(options.depth).fill([]);
  // initialize the depth.
  var currentDepth = 0;
  // need to use a relativeDepth to deal with level 0.
  var relativeDepth = options.depth + 1;

  // generate the stratified array representation of the node_module tree.
  while (currentDepth < options.depth) {
    // parent nodes, if this is loop 0 use the project root as the 'parent' as it is the top node_module in context.
    var parents = currentDepth > 0 ? modules[currentDepth -1] : [data];

    parents.forEach(function(parent) {
      if (parent && !_.isEmpty(parent._dependencies)) {
        var explicitDependancies = Object.keys(parent._dependencies || {});
        var devDependencies = Object.keys(parent.devDependencies || {});
        var dependencies = options.production ? _.concat([], explicitDependancies) : _.concat([], explicitDependancies, devDependencies);

        var unflattenedDeps = dependencies.reduce(function(acc, dependency){
          var thisDependency = parent.dependencies[dependency];
          if (thisDependency) {
            acc.push(thisDependency);
          }
          return acc;
        }, []);

        modules[currentDepth] = _.concat(modules[currentDepth], unflattenedDeps);
      }
    });
    // options.prune?
    // huge optimization by pruning duplicates - by experimentation reduces traversal by an order of magnitude in our ~200MB repositories.
    modules[currentDepth] = _.uniqBy(modules[currentDepth], 'name');
    currentDepth++;
  }

  // Reduce the collection from Array<Array<Module>> to Array<Module> - was a flattenDeep
  var flatResults = [];
  modules.forEach(function(moduleCollection) {
    flatResults = _.concat(flatResults, moduleCollection);
  });
  // TODO: should we log removed forks?
  var uniqResults = _.uniqBy(flatResults, 'name');
  // with flat results search for license files:
  console.log('============================ STATS ===========================');
  console.log('deep module count: ', flatResults.length);
  console.log('unique module count: ', uniqResults.length);
  console.log('==============================================================');
  var callback = function(err, data) {
    // console.log(data);
  };
  var output = {};
  var count = 0;
  uniqResults.map(function(result) {
    // we're going to call the async function - so increase count
    count++;
    createModule(result, function (err, module) {
      count--;
      if (err) {
        return callback(err);
      }

      // add this module to the output object/collection
      output[result._id] = module;

      // if count falls to zero, we are finished
      if (count === 0) {
        callback(null, output);
      }
    });
  });

});

/**
 * Create a module object from a record in readInstalled
 *
 * @param  {Object}   moduleData The module data object
 * @param  {Function} callback   Callback (err, Array of module object)
 */
function createModule(moduleData, callback) {
	var repository = (moduleData.repository || {}).url || '(none)';
	var directory = moduleData.path;
	var id = createId(moduleData);
  var name = moduleData.name || id;
	var version = moduleData.version || '0.0.0';
	var module = new Module(id, name, version, directory, repository);

	// glob for license files
	findPotentialLicenseFiles(directory, '*li@(c|s)en@(c|s)e*',
		function (err, licenseFiles) {

		if (err) {
			return callback(err);
		}

		addFiles(licenseFiles, module.licenseSources.license, function (err) {

			if (err) {
				return callback(err);
			}

			// glob for readme files
			findPotentialLicenseFiles(directory, '*readme*',
				function (err, readmeFiles) {

				if (err) {
					return callback(err);
				}

				addFiles(readmeFiles, module.licenseSources.readme, function (err) {
					if (err) {
						return callback(err);
					}

					addPackageJson(moduleData, module);

					callback(null, module);
				});
			});
		});
	});
}

/**
 * Find potential license files - using glob matching
 *
 * @param  {String}   directory The directory to search in
 * @param  {String}   pattern   The glob pattern to apply
 * @param  {Function} callback  Callback (err, arrayOfPaths)
 */
function findPotentialLicenseFiles(directory, pattern, callback) {

	if (typeof pattern !== 'string') {
		return callback(new Error('pattern must be a string'));
	}

	if (typeof directory !== 'string') {
		return callback(new Error('directory must be a string'));
	}

	// glob to find all files that match the pattern
	globIgnoringModules(directory, pattern, function (err, files) {

		if (err) {
			return callback(err);
		}

		var fileIndex,
			matchedFile,
			found = [];

		for (fileIndex = files.length - 1; fileIndex >= 0; fileIndex--) {
			matchedFile = files[fileIndex];

			var filePath = path.join(directory, matchedFile);
			// check that it is a file
			if (fs.statSync(filePath).isFile()) {
				found.push(filePath);
			}
		}

		callback(null, found);
	});
}

/**
 * Add files to a module's collection
 *
 * @param {Array}    filePaths  Array of file paths
 * @param {Array }   collection The collection to add the fileSource objects to
 * @param {Function} callback   Callback (err);
 */
function addFiles(filePaths, collection, callback) {
  debugger;

	// if this is called with a missing or empty list - just callback
	if (!filePaths || filePaths.length === 0) {
		return callback(null);
	}

	var fileIndex,
		pending = filePaths.length,
		source;

	/**
	 * Check whether we have completed the list
	 */
	function checkDone(err) {
		if (err) {
			callback(err);
		}

		pending--;
		if (!pending) {
			callback(null);
		}
	}

	// iterate over all the file paths
	for (fileIndex = 0; fileIndex < filePaths.length; fileIndex++) {
		source = new FileSource(filePaths[fileIndex]);
		collection.add(source);
		// read the files
		source.read(checkDone);
	}
}

/**
 * Add licenses from package.json file
 *
 * @param {Object} moduleData The package.json data
 * @param {Object} module     The module to add the licenses to
 */
function addPackageJson(moduleData, module) {

	var licenses = moduleData.licenses,
		license = moduleData.license;

	// finally, if there is data in package.json relating to licenses
	// simple license declarations first
	if (typeof license === 'string' || typeof license === 'object') {
		module.licenseSources.package.add(new PackageSource(license));
	}

	// correct use of licenses array
	if (Array.isArray(licenses)) {
		for (var index = 0; index < licenses.length; index++) {
			module.licenseSources.package.add(
				new PackageSource(licenses[index])
			);
		}
	} else if (typeof licenses === 'string' || typeof licenses === 'object') {
		// some modules incorrectly have a string or object licenses property
		return module.licenseSources.package.add(new PackageSource(licenses));
	}
}

/**
 * Perform a glob search, but specifically ignoring
 * the node_modules folder, and not using the glob
 * 'ignore' as this is just a final filter on the result
 * and is very slow
 *
 * @param {String}   directory   The path of the directory to search from
 * @param {String}   filePattern A glob file pattern, e.g. *.js
 * @param {Function} callback    (err, results)
 */
function globIgnoringModules(directory, filePattern, callback) {

	// find all the subdirectories, but ignoring the node modules
	glob('*/', {
		cwd: directory,
		ignore: ['**/node_modules/**', '**/bower_components/**']
	}, function(err, subdirs) {
		if (err) {
			return callback(err);
		}

		// convert the directories into individual glob patterns
		var globpatterns = [];
		for (var index = 0; index < subdirs.length; index++) {
			globpatterns.push(subdirs[index] + '**/' + filePattern);
		}

		// add a pattern for the root directory
		globpatterns.push(filePattern);

		// now do the glob proper
		glob(globpatterns, {
			nocase: true,
			cwd: directory,
			ignore: ['**/node_modules/**', '**/bower_components/**']
		}, callback);

	});
}

/**
 * Creates an ID for a module
 * @param {Object} moduleData read-installed module data
 */
function createId(moduleData) {

	if (!moduleData._id || moduleData._id === '@') {
		return 'unknown(' + moduleData.path + ')@0.0.0';
	}

	return moduleData._id;
}



// function otherTraversal(module) {
//   var deps = [].concat(Object.keys(node._dependencies || {}));
//   if (!_.isEmpty(deps)) {
//     var unflattenedDeps = deps.reduce(function(acc, dep){
//       acc[dep] = node.dependencies[dep];
//       return acc;
//     }, {});
//   }
//
// }
//
// function traverse(node) {
//   // parent:
//   // var root = {};
//   // data.dependencies = node. // Picks = data._dependencies && data.devDependencies.
//   var deps = [].concat(Object.keys(node._dependencies || {}));
//   var unflattenedDeps = deps.reduce(function(acc, dep){
//     acc[dep] = node.dependencies[dep];
//     return acc;
//   }, {})
//   // var unflattenedDeps = _.pick(node.dependencies, deps);
//   // Add those to the root object.
//   Object.assign(node, { "dependencies": unflattenedDeps });
//   // For each added node - get its deps & devDependencies and add it to its parent.
//   Object.keys(unflattenedDeps).map(function(name) {
//     var thisNode = unflattenedDeps[name];
//     console.log(name);
//     if (thisNode && thisNode._dependencies) {
//       traverse(thisNode);
//     }
//   });
// }
