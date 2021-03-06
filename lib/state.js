/*
 * This is primarly where dew talks to docker for you.
 * Of course you can always just take control of the
 * container with with `scope.state.getContainer()`
 * or access `scope.state.dockerConnection.docker`
 */
var dockerConnect = require('./docker_connect')
  , Promise = require('bluebird')
  , rimraf = require('rimraf')
  , _ = require('lodash')

function State(scope) {
  var dockerConnection = dockerConnect.connect()
    , docker = dockerConnection.docker
    , state = null

  state = {
    dockerConnection: dockerConnection,
    getContainer: function () {
      return docker.getContainer(scope.storage.getItem('_id'))
    },
    apply: function (scope, config, cb) {
      this.getContainer().inspect(function (err, res) {
        if (err) {
          this.handleInspectError(err, config, cb)
        } else {
          state.ensure(cb);
        }
      }.bind(this));
    },
    handleInspectError: function (err, config, cb) {
      if (err.statusCode === 404) {
        if (! config.create.Image) {
          return cb(new Error("Missing create option 'Image'"))
        }
        docker.createContainer(config.create, function (err, container) {
          if (err) {
            if (err.statusCode === 404) {
              state.pullImage(config.create.Image, function (err, res) {
                if (err) {
                  cb(new Error(err))
                } else {
                  state.apply(scope, config, cb);
                }
              });
            } else cb(new Error(err))
          } else {
            scope.storage.setItem('_id', container.id);
            container.start(config.start, function (err) {
              if (err) cb(err);
              else state.apply(scope, config, cb);
            });
          }
        });
      } else {
        if (err.code === "EACCES" && err.syscall === "connect" && dockerConnection.socketPath) {
          console.error("Permission to access socket "+dockerConnection.socketPath+" was denied. You may want to use sudo.");
          cb(null);
        } else {
          cb(err);
        }
      }
    },
    ensure: function (cb) {
      state.getContainer().inspect(function (err, liveInfo) {
        if (err) { cb(new Error(err)) }
        else if ( liveInfo.State.Running ) {
          cb(null)
        } else {
          state.getContainer().start(function () {
            state.ensure(cb)
          });
        }
      });
    },
    pullImage: function (image, cb) {
      docker.pull(image, function (err, stream) {  
        if (err) cb(new Error(err))
          else {
            stream.on('end', function() { cb(err) });
            stream.on('error', function(e2) { err = new Error(e2) });
            stream.on('data', function (chunk) {
              var data = JSON.parse(chunk.toString());
              if (data.error) {
                err = new Error("Pull failed. "+data.error)
              } else {
                // TODO consider using https://www.npmjs.org/package/progress
                console.info(data);
              }
            });
          }
      });
    },
    destroy: function (cb) {
      this.getContainer().remove({
        force: true, // Stop container and remove
        v: true // Remove volumes
      }, function (err) {
        if (err) {
          if (err.statusCode === 404) {
            console.error("Container not found -- nothing to destroy");
          } else {
            console.error(err);
          }
        }
        var promises = [];
        promises.push(promiseManagedVolumeRemoval());
        promises.push(promiseManagedLinksRemoval());
        promises.push(promiseScopeRemoval());
        Promise.all(promises).finally(cb);
      })
    }
  } 

  var promiseManagedLinksRemoval = function () {
    return new Promise(function (resolve, reject) {
      var linksJSON = scope.storage.getItem('_managedLinks')
      if (!linksJSON) return resolve();
      var links = JSON.parse((linksJSON))
      var done = _.after(links.Scopes.length, resolve)
      var Scope = require('./scope')
      _.each(links.Scopes, function (scopeData) {
        new Scope({
          home: scopeData.home,
          name: scopeData.name
        }).destroy(done)
      })
    })
  }

  var promiseManagedVolumeRemoval = function () {
    return new Promise(function (resolve, reject) {
      var volumesJSON = scope.storage.getItem('_managedVolumes')
      if (!volumesJSON) return resolve();
      var volumes = JSON.parse(volumesJSON).Binds;
      if (volumes.length === 0) return resolve();
      var done = _.after(volumes.length, resolve)
      _.each(volumes, function (pair) {
        var path = pair.split(':')[0]
        rimraf(path, function (err) {
          if (err) reject(err);
          else done();
        })
      })
    })
  }

  var promiseScopeRemoval = function () {
    return new Promise(function (resolve, reject) {
      rimraf(scope.home, function () { resolve() });
      // TODO empty namespace? remove it.
    });
  }

  return state;
}

module.exports = State;
