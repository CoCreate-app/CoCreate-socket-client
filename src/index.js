(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(["@cocreate/uuid", "@cocreate/indexeddb"], function(uuid, indexeddb) {
        	return factory(true, WebSocket, Blob, uuid, indexeddb)
        });
    } else if (typeof module === 'object' && module.exports) {
        const ws = require("ws")
        const uuid = require("@cocreate/uuid");
    	module.exports = factory(false, ws, null, uuid);
    } else {
        // Browser globals (root is window)
        root.returnExports = factory(true, WebSocket, Blob, root["@cocreate/uuid"], root["@cocreate/indexeddb"]);
  }
}(typeof self !== 'undefined' ? self : this, function (isBrowser, WebSocket, Blob, uuid, indexeddb) {
	if(indexeddb && indexeddb.default)
		indexeddb = indexeddb.default

	const delay = 1000 + Math.floor(Math.random() * 3000)
    const CoCreateSocketClient = {
		sockets: new Map(),
		listeners: new Map(),
		messageQueue:  new Map(),
		saveFileName:  '',
		clientId: uuid.generate(8),	
		config: {},
		initialReconnectDelay: delay,
		currentReconnectDelay: delay,
		maxReconnectDelay: 600000,

			
		/**
		 * config: {organization_id, namespace, room, host, port}
		 */
		create (config) {
			const self = this;
			if (isBrowser) {
				if (!window.navigator.onLine)
					window.addEventListener("online", this.online);

				if (!config)
					config = {};
				if (!window.CoCreateConfig)
					window.CoCreateConfig = {};
				if (!config.organization_id) {						
					config.organization_id = window.CoCreateConfig.organization_id || window.localStorage.getItem('organization_id')

					if (!config.organization_id) {
						config.organization_id = indexeddb.ObjectId()
						config.apiKey = uuid.generate(32)
						indexeddb.generateDB(config)
					}
					window.localStorage.setItem('organization_id', config.organization_id) 
				}
				if (!config.apiKey) {
					config.apiKey = window.CoCreateConfig.apiKey || window.localStorage.getItem('apiKey') || uuid.generate(32)
					window.localStorage.setItem('apiKey', config.apiKey) 				
				}
				if (!config.host) {
					config.host = window.CoCreateConfig.host || window.localStorage.getItem('host') || window.location.hostname
					window.localStorage.setItem('host', config.host) 				
				}
				// if (!config.port) {
				// 	config.port = window.CoCreateConfig.port || window.localStorage.getItem('port') || ''
				// 	window.localStorage.setItem('port', config.port) 				
				// }
				// if (!config.prefix) {
				// 	config.prefix = "ws"; // previously 'crud'
				// }
				
				// this.config = config
				window.CoCreateConfig = config;
			}
						
			this.config = config
			
			const url = this.getUrl(config);
			let socket = this.sockets.get(url);
			if (socket) 
				return;

			try {
				socket = new WebSocket(url);
				socket.clientId = this.clientId;
				socket.organization_id = config.organization_id;
				socket.user_id = config.user_id;
				socket.host = config.host;
				socket.prefix = config.prefix || 'ws';
				socket.config = {...config, prefix: config.prefix || 'ws'};

				this.sockets.set(url, socket);
			} catch(error) {
				console.log(error);
				return;
			}

			socket.onopen = function(event) {
				socket.connected = true;
				self.currentReconnectDelay = self.initialReconnectDelay
				self.checkMessageQueue(socket);
			};
			
			socket.onclose = function(event) {
				socket.connected = false;

				switch(event.code) {
					case 1000: // close normal
						console.log("websocket: closed");
						break;
					default: 
						self.destroy(socket);
						self.reconnect(config);
						break;
				}
			};
			
			socket.onerror = function(event) {
				if (isBrowser && !window.navigator.onLine)
					console.log("offline");
				else
					console.log("connection failed");
				
				self.destroy(socket);
				self.reconnect(config);
			};
	
			socket.onmessage = function(data) {
				try {
					if (isBrowser && window.Blob) {
						if (data.data instanceof Blob) {
							self.saveFile(data.data);
							return;
						}
					}
					let rev_data = JSON.parse(data.data);
					if (rev_data.module != 'connect')
						rev_data.data.status = "received"

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
						listener(rev_data.data, url);
					});
				} catch (e) {
					console.log(e);
				}
			};
		},
		
		__fireEvent(event_id, data) {
			if (isBrowser) {
				var event = new window.CustomEvent(event_id, {
					detail: data
				});
				window.dispatchEvent(event);
			} else {
				process.emit(event_id, data);
			}
		},
		
		checkMessageQueue(socket){
			if (!isBrowser) {
				if (this.messageQueue.size > 0){
					for (let [request_id, {module, data}] of this.messageQueue) {
						this.send(module, data)
						this.messageQueue.delete(request_id);
					}
				}
			} else {
				indexeddb.readDocuments({
					database: 'socketMessageQueue',
					collection: socket.url,
				}).then((data) =>{
					if (data.data)
						for (let Data of data.data) {
							this.send(Data.module, Data.data)
							Data.database = 'socketMessageQueue';
							Data.collection = socket.url
							Data.data = {_id: Data._id}
							indexeddb.deleteDocument(Data)
						}
				})
			}
		},
		
		send (module, data) {
			return new Promise((resolve, reject) => {
				const request_id = uuid.generate();
				const clientId = this.clientId;
				
	            if(!data['organization_id']) {
	                data['organization_id'] = this.config.organization_id;
	            }
	            if(!data['apiKey']) {
	                data['apiKey'] = this.config.apiKey;
	            }
				if(!data['user_id']) {
	                data['user_id'] = this.config.user_id;
	            }
	            if(data['broadcastSender'] === undefined) {
	                data['broadcastSender'] = true;
	            }

				const socket = this.getSocket(data);

				const obj = {
					module,
					data: {...data, uid: request_id, clientId}
				};
				if (!isBrowser)
				    obj.data['event'] = request_id;

				let online = true;
				if (isBrowser && !window.navigator.onLine)
					online = false
				if (socket && socket.connected && online) {
					socket.send(JSON.stringify(obj));
					data.status = "sent"
					if (isBrowser) {
						window.addEventListener(request_id, function(event) {
							resolve(event.detail);
						}, { once: true });
					} else {
						process.once(request_id, (data) => {
							resolve(data);
						});
					}
				} else {
					data.status = "queued"
					if (!isBrowser)
						this.messageQueue.set(request_id, {module, data});
					else {
						indexeddb.createDocument({
							database: 'socketMessageQueue',
							collection: socket.url,
							data: {_id: request_id, module: module, data: data}
						})
					}
					resolve(data)
				}
			});
		},
		

		sendFile (file, room) {
			const socket = this.getByRoom(room);
			if (socket) {
				socket.send(file);
			}
		},
	
		listen(type, callback) {
			if (!this.listeners.get(type)) {
				this.listeners.set(type, [callback]);
			} else {
				this.listeners.get(type).push(callback);
			}
		},

		online (config) {
			window.removeEventListener("online", this.online)
			this.create(config)
		},

		reconnect(config) {
			let self = this;

			setTimeout(() => {
				if(!self.maxReconnectDelay || self.currentReconnectDelay < self.maxReconnectDelay) {
					self.currentReconnectDelay*=2;
					self.create(config);
				}
			}, self.currentReconnectDelay);
			
		},
		
		destroy(socket) {
			if (socket) {
				this.sockets.delete(socket.url);
				socket.onerror = socket.onopen = socket.onclose = null;
				socket.close();
				socket = null;
			}			
		},
		
		getUrl(data = {}) {
			let w_protocol = ''
			if (isBrowser) {
				w_protocol = window.location.protocol;		
				if (window.location.protocol === "about:")
					w_protocol = window.parent.location.protocol;
			}
			let protocol = w_protocol === 'http:' ? 'ws' : 'wss';
			let port = data.port || this.config.port || '';
			let url;
			let host = data.host || this.config.host
			if (host) {
				if (host.includes("://")) {
					url = `${host}`;
				} else {
					if (host.includes(":")) {
						url = `${protocol}://${host}`;
					} else {
						url = `${protocol}://${host}${port}`;	
					}
				}
			} else if (isBrowser) {
				url = `${protocol}://${window.location.host}${port}/`;
			} else {
				return console.log('missing host')
			}

			let prefix = data.prefix || 'ws';
			let organization_id = data.organization_id || this.config.organization_id;
			let namespace = data.namespace || '';
			let room = data.room || '';
			if (prefix && prefix != '')
				url += `/${prefix}`
			if (organization_id &&  organization_id != '')
				url += `/${organization_id}`
			if (namespace &&  namespace != '')
				url += `/${namespace}`
			if (room &&  room != '')
				url += `/${room}`

			return url;
		},
		
		getSocket(data) {
			let url = this.getUrl(data)
			let socket = this.sockets.get(url)
			if (!socket) {
				this.create(data)
				socket = {url: url}
			}
			return socket;	
		},
			
	}
    return CoCreateSocketClient;
})
);
