// TODO: mix this into the find function.
"strict";

var compact = require('lodash.compact');
var concat = require('lodash.concat');
var countBy = require('lodash.countby');
var isEmpty = require('lodash.isempty');
var transform = require('lodash.transform');
var uniqBy = require('lodash.uniqby');

// DEPS FROM NLF:
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
options.depth = undefined;
// caveat prune forks and production should be false at the same time...
options.production = false;
options.pruneForks = false;
options.log = true;

// readInstalled('/Users/murrayl/projects/ohw-web-components/ohw-conditions-card', function(err, data) {
readInstalled(__dirname, function(err, data) {
  // initialize the depth.
  var currentDepth = 0;
  // make the array to hold module 'dirs' - Array(undefined) defaults to a length 1 array.
  var modules = Array(options.depth).fill([]);
  var uniqueModules = {};

  // Vars built from options:
  var moduleId = options.pruneForks ? "name" : "_id";
  var exhaustModules;
  var relativeDepth;
  // need to use a relativeDepth to deal with level 0.
  if (options.depth !== undefined) {
    exhaustModules = false;
    relativeDepth = options.depth + 1;
  } else {
    exhaustModules = true;
    relativeDepth = Number.MAX_SAFE_INTEGER;
  }

  // generate the stratified array representation of the node_module tree.
  while ((currentDepth < relativeDepth) || exhaustModules) {
    // parent nodes, if this is loop 0 use the project root as the 'parent' as it is the top node_module in context.
    var parents = currentDepth > 0 ? modules[currentDepth -1] : [data];

    parents.forEach(function(parent) {
      if (parent && !isEmpty(parent._dependencies)) {
        // use dependencies and devDependencies to traverse the tree as if it were deep.
        var explicitDependancies = Object.keys(parent._dependencies || {});
        var devDependencies = Object.keys(parent.devDependencies || {});
        var dependencies = !options.production ? concat([], explicitDependancies, devDependencies): concat([], explicitDependancies);

        var unflattenedDeps = dependencies.reduce(function(acc, dependency){
          var thisDependency = parent.dependencies[dependency];
          // additional logic for prune forks here.
          if (thisDependency && !uniqueModules.hasOwnProperty(thisDependency[moduleId])) {
            acc.push(thisDependency);
            // append the data to the uniqueModules map... :/
            uniqueModules[thisDependency[moduleId]] = true;
          }
          return acc;
        }, []);

        modules[currentDepth] = concat(modules[currentDepth], unflattenedDeps);
      }
    });
    modules[currentDepth] = compact(modules[currentDepth]);
    modules[currentDepth] = uniqBy(modules[currentDepth], '_id');

    console.log(currentDepth, modules[currentDepth].length);
    if (modules[currentDepth].length === 0) {
      break;
    }
    currentDepth++;
  }

  // Reduce the collection from Array<Array<Module>> to Array<Module> - was a flattenDeep
  var flatResults = [];
  modules.forEach(function(moduleCollection) {
    flatResults = concat(flatResults, moduleCollection);
  });
  // TODO: should we log removed forks?
  var uniqResults = uniqBy(flatResults, 'name');

  // with flat results search for license files:
  if (options.log) {
    console.log('============================ STATS ===========================');
    console.log('deep module count: ', flatResults.length);
    console.log('unique module count: ', uniqResults.length);
    // log forks.
    if (!options.pruneForks) {
      var forks = transform(countBy(flatResults, function(module) { return module.name }), function(result, count, value) {
        if (count > 1) result.push(value);
      }, []);

      if (forks.length > 0 ) {
        console.log('============================ FORKS ===========================');
        forks.sort();
        forks.map(function(moduleName) {
          var theseForks = flatResults.filter(function(module) { return moduleName === module.name })
            .map(function(module) { return module.version })
            .sort();
          console.log(moduleName + ': ', theseForks.join(', '));
        });
      }
    }

    console.log('==============================================================');
  }
  var callback = function(err, data) {
    console.log(data.name);
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

// THE FOLLOWING WAS ALREADY IN NLF:

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

/**
 * Is this module a development dependency of its parent?
 *
 * @param  {Object}  moduleData The module's data
 * @return {Boolean}            True if the module is a production dependency
 */
function isDevDependency(moduleData) {

	// this might be the root object - which by definition is production
	if (moduleData.parent === undefined) {
		return false;
	}

	if (moduleData.extraneous) {
		return true;
	}

	var dependencies = moduleData.parent.devDependencies || {},
		dependencyName;

	// look for this module in the production dependencies of the parent
	// and return true if it is found
	for (dependencyName in dependencies) {
		if (dependencies.hasOwnProperty(dependencyName)) {
			if (dependencyName === moduleData.name) {
				return true;
			}
		}
	}

	return false;
}
