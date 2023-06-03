(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define(["./socket"], function(CoCreateSocket) {
        	return factory(CoCreateSocket)
        });
    } else if (typeof module === 'object' && module.exports) {
      const CoCreateSocket = require("./socket.js")
      module.exports = factory(CoCreateSocket);
    } else {
        root.returnExports = factory(root["./socket.js"]);
  }
}(typeof self !== 'undefined' ? self : this, function (CoCreateSocket) {
  return CoCreateSocket;
}));