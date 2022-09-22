(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(["@cocreate/uuid", "@cocreate/indexeddb"], function(uuid, indexeddb) {
        	return factory(window, WebSocket, Blob, uuid, indexeddb)
        });
    } else if (typeof module === 'object' && module.exports) {
        let wndObj = {
        	location: {
        		protocol: ""
        	}
        }
        const ws = require("ws")
        const uuid = require("@cocreate/uuid");
    	module.exports = factory(wndObj, ws, null, uuid);
    } else {
        // Browser globals (root is window)
        root.returnExports = factory(window, WebSocket, Blob, root["@cocreate/uuid"], root["@cocreate/indexeddb"]);
  }
}(typeof self !== 'undefined' ? self : this, function (wnd, WebSocket, Blob, uuid, indexeddb) {

    class CoCreateSocketClient
	{
		constructor(prefix = "crud") {
			this.prefix = prefix || "crud";
			this.sockets = new Map();
			this.listeners = new Map();
			this.messageQueue =  new Map();
			this.saveFileName =  '';
			this.globalScope =  "";
			this.clientId = uuid.generate(8);
			this.initialReconnectDelay = 1000 + Math.floor(Math.random() * 3000);
			this.currentReconnectDelay = this.initialReconnectDelay;
			this.maxReconnectDelay = 600000;

		}
	
		setGlobalScope(scope) {
			this.globalScope = `${this.prefix}/${scope}`;
		}
		
		getGlobalScope() {
			return this.globalScope;
		}
		
		/**
		 * config: {namespace, room, host}
		 */

		create (config) {
			const self = this;
			if ( window && !window.navigator.onLine){
				window.addEventListener("online", this.online);
				return
			}

			let {namespace, room} = config;
			if (!namespace)
				namespace = config.organization_id
			const key = this.getKey(namespace, room);
			if (namespace) {
				this.setGlobalScope(namespace)
			}
			
			let socket = this.sockets.get(key);
			if (socket) 
				return;
			
			let w_protocol = wnd.location.protocol;		
			if (wnd.location.protocol === "about:") {
				w_protocol = wnd.parent.location.protocol;
				if (!config.host) {
					config.host = wnd.parent.location.host;
				}
			}
			let protocol = w_protocol === 'http:' ? 'ws' : 'wss';
			
			const portPrefix = config.port ? `:${config.port}` : '';
			
			let socket_url = `${protocol}://${wnd.location.host}${portPrefix}/${key}`;
			
			if (config.host) {
				if (config.host.includes("://")) {
					socket_url = `${config.host}/${key}`;
				} else {
					if (config.host.includes(":")) {
						socket_url = `${protocol}://${config.host}/${key}`;
					} else {
						socket_url = `${protocol}://${config.host}${portPrefix}/${key}`;	
					}
				}
			}
			try {
				let token = null;
				if (wnd.localStorage) {
					token = wnd.localStorage.getItem("token");
				}
				socket = new WebSocket(socket_url, token);
				// socket.connected = false;
				// if (config.clientId)
				// 	this.clientId = config.clientId
				socket.clientId = this.clientId;
				this.sockets.set(key, socket);
			} catch(error) {
				console.log(error);
				return;
			}

			socket.onopen = function(event) {
				socket.connected = true;
				self.currentReconnectDelay = self.initialReconnectDelay
				self.checkMessageQueue();
			};
			
			socket.onclose = function(event) {
				socket.connected = false;

				switch(event.code) {
					case 1000: // close normal
						console.log("websocket: closed");
						break;
					default: 
						self.destroy(socket, key);
						self.reconnect(socket, config);
						break;
				}
			};
			
			socket.onerror = function(err) {
				console.log(err.message);
				self.destroy(socket, key);
				self.reconnect(socket, config);
			};
	
			socket.onmessage = function(data) {
				try {
					if (wnd.Blob) {
						if (data.data instanceof Blob) {
							self.saveFile(data.data);
							return;
						}
					}
					let rev_data = JSON.parse(data.data);

					if (rev_data.data) {
						
						if (rev_data.data.uid) {
							self.__fireEvent(rev_data.data.uid, rev_data.data);
						}
						if (rev_data.data.event) {
							self.__fireEvent(rev_data.data.event, rev_data.data);
							return;
						}
						
					}
					const listeners = self.listeners.get(rev_data.module);
					if (!listeners) {
						return;
					}
					listeners.forEach(listener => {
						listener(rev_data.data, key);
					});
				} catch (e) {
					console.log(e);
				}
			};
		}
		
		__fireEvent(event_id, data) {
			if (wnd.CustomEvent) {
				var event = new wnd.CustomEvent(event_id, {
					detail: data
				});
				wnd.dispatchEvent(event);
			} else {
				process.emit(event_id, data);
			}
		}
		
		checkMessageQueue(){
			if (!wnd.document) {
				if (this.messageQueue.size > 0){
					// for (let [request_id, {channel, obj}] of this.messageQueue) {
					for (let [request_id, {module, data}] of this.messageQueue) {
						this.send(module, data)
						this.messageQueue.delete(request_id);
					}
				}
			}
			else {
				indexeddb.readDocuments({
					database: 'socketMessageQueue',
					collection: 'socketMessageQueue',
				}).then((data) =>{
					if (data.data)
						for (let Data of data.data) {
							this.send(Data.module, Data.data)
							Data.database = 'socketMessageQueue'
							Data.collection = 'socketMessageQueue'
							Data.data = {_id: Data._id}
							indexeddb.deleteDocument(Data)
						}
				})
			}
		}
		
		send (module, data) {
			return new Promise((resolve, reject) => {
				const request_id = uuid.generate();
				const socket = this.getSocket(data);
				const clientId = this.clientId;
				
	            if(!data['organization_id']) {
	                data['organization_id'] = config.organization_id;
	            }
	            if(!data['apiKey']) {
	                data['apiKey'] = config.apiKey;
	            }
	            if(data['broadcastSender'] === undefined) {
	                data['broadcastSender'] = true;
	            }
	            
				const obj = {
					module,
					data: {...data, uid: request_id, clientId}
				};
				if (!wnd.document)
				    obj.data['event'] = request_id;

				let online = true;
				if (wnd.document && !wnd.navigator.onLine)
					online = false
				if (socket && socket.connected && online) {
					socket.send(JSON.stringify(obj));
					if (wnd.document) { //. browser case
						wnd.addEventListener(request_id, function(event) {
							resolve(event.detail);
						}, { once: true });
					} else { //. node case
						process.once(request_id, (data) => {
							resolve(data);
						});
					}
				} else {
					if (!wnd.document)
						this.messageQueue.set(request_id, {module, data});
					else {
						indexeddb.createDocument({
							database: 'socketMessageQueue',
							collection: 'socketMessageQueue',
							data: {_id: request_id, module: module, data: data}
						})
					}
					resolve(data)
				}
				// if (wnd.document) { //. browser case
				// 	wnd.addEventListener(request_id, function(event) {
				// 		resolve(event.detail);
				// 	}, { once: true });
				// } else { //. node case
				// 	process.once(request_id, (data) => {
				// 		resolve(data);
				// 	});
				// }
			});
		}
		

		sendFile (file, room) {
			const socket = this.getByRoom(room);
			if (socket) {
				socket.send(file);
			}
		}
	
		/**
		 * scope: ns/room
		 */
		listen(type, callback) {
			if (!this.listeners.get(type)) {
				this.listeners.set(type, [callback]);
			} else {
				this.listeners.get(type).push(callback);
			}
		}

		online (config) {
			window.removeEventListener("online", this.online)
			this.create(config)
		}

		// ToDo: Apply a backoff 
		reconnect(socket, config) {
			let self = this;
			// setTimeout(function() {
			// 	self.create(config);
			// }, 1000)
			setTimeout(() => {
				if(!self.maxReconnectDelay || self.currentReconnectDelay < self.maxReconnectDelay) {
					self.currentReconnectDelay*=2;
					self.create(config);
				}
			}, self.currentReconnectDelay);
			
		}
		
		destroy(socket, key) {
			if (socket) {
				socket.onerror = socket.onopen = socket.onclose = null;
				socket.close();
				socket = null;
			}
			
			if (this.sockets.get(key)) {
				this.sockets.delete(key);
			}
		}
		
		destroyByKey(key) {
			let socket = this.sockets.get(key); 
			if (socket) {
				this.destroy(socket, key);
			}
		}
		
		getKey(namespace, room) {
			let key = `${this.prefix}`;
			if (namespace && namespace != '') {
				if (room &&  room != '') {
					key += `/${namespace}/${room}`;
				} else {
					key +=`/${namespace}`;
				}
			}
			return key;
		}
		
		getSocket(data) {
			let key = this.globalScope;
			let ns = data.namespace || config.organization_id;
			let rm = data.room || '';
			if (rm)
				key = `${this.prefix}/${ns}/${rm}`
			else
				key = `${this.prefix}/${ns}`

			return this.sockets.get(key);	
		}
		
		getCommonParams(info) {
			let config = {};
			if (wnd && wnd.config) config = wnd.config;

			return {
				"apiKey": info.apiKey || config.apiKey,
				"organization_id": info.organization_id || config.organization_id,
			};
		}
		
		getClientId() {
			return this.clientId;	
		}
	}
    return CoCreateSocketClient;
}));
