// Initial idea.
"strict";

var readInstalled = require('read-installed');
var _ = require('lodash');

return new Promise(function(resolve, reject) {
  // readInstalled('/Users/murrayl/projects/ohw-web-components/ohw-allergies-card', function(err, data) {
  readInstalled(__dirname, function(err, data) {
    var tree = {};
    traverse(data, tree);
    console.log(tree);
    resolve(tree);
  });
});

function traverse(node) {
  // parent:
  // var root = {};
  // data.dependencies = node. // Picks = data._dependencies && data.devDependencies.
  var deps = [].concat(Object.keys(node._dependencies || {}));
  var unflattenedDeps = deps.reduce(function(acc, dep){
    acc[dep] = node.dependencies[dep];
    return acc;
  }, {})
  // var unflattenedDeps = _.pick(node.dependencies, deps);
  // Add those to the root object.
  Object.assign(node, { "dependencies": unflattenedDeps });
  // For each added node - get its deps & devDependencies and add it to its parent.
  Object.keys(unflattenedDeps).map(function(name) {
    var thisNode = unflattenedDeps[name];
    console.log(name);
    if (thisNode && thisNode._dependencies) {
      traverse(thisNode);
    }
  });
}
