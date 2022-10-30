(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(["@cocreate/uuid", "@cocreate/indexeddb"], function(uuid, indexeddb) {
        	return {default: factory(true, WebSocket, Blob, uuid, indexeddb)}
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
		connected: false,
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
					window.CoCreateConfig.organization_id = config.organization_id						
				}
				if (!config.apiKey) {
					config.apiKey = window.CoCreateConfig.apiKey || window.localStorage.getItem('apiKey') || uuid.generate(32)
					window.localStorage.setItem('apiKey', config.apiKey) 
					window.CoCreateConfig.apiKey = config.apiKey						
				}
				if (!config.host) {
					config.host = window.CoCreateConfig.host || window.localStorage.getItem('host') || window.location.hostname
					window.localStorage.setItem('host', config.host)
					window.CoCreateConfig.host = config.host		
				}
				// if (!config.port) {
				// 	config.port = window.CoCreateConfig.port || window.localStorage.getItem('port') || ''
				// 	window.localStorage.setItem('port', config.port) 				
				// }
				// if (!config.prefix) {
				// 	config.prefix = "ws"; // previously 'crud'
				// }
				
			}
						
			this.config = config
			
			const urls = this.getUrls(config);
			for (let url of urls){
				let socket = this.sockets.get(url);
				if (socket) 
					return;
	
				try {
					let token = null;
					if (isBrowser && window.localStorage) {
						token = window.localStorage.getItem("token");
					}
					socket = new WebSocket(url, token)
					socket.connected = false;					
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
					this.connected = true
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
						if (rev_data.module != 'connect' && typeof rev_data.data == 'object')
						if (rev_data.data.status == "received locally")
							rev_data.data.status = "sync"
						else
							rev_data.data.status = "received"
	
						if (rev_data.data) {
							if (rev_data.data.uid) {
								self.__fireEvent(rev_data.data.uid, rev_data.data);
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
	
			}
		},
		
		__fireEvent(uid, data) {
			if (isBrowser) {
				var event = new window.CustomEvent(uid, {
					detail: data
				});
				window.dispatchEvent(event);
			} else {
				process.emit(uid, data);
			}
		},
		
		checkMessageQueue(socket){
			if (!isBrowser) {
				if (this.messageQueue.size > 0){
					for (let [uid, {module, data}] of this.messageQueue) {
						this.send(module, data)
						this.messageQueue.delete(uid);
					}
				}
			} else {
				indexeddb.readDocument({
					database: 'socketMessageQueue',
					collection: socket.url,
					filter: {}
				}).then((data) =>{
					if (data.document)
						for (let Data of data.document) {
							this.send(Data.module, Data.document)
							Data.database = 'socketMessageQueue';
							Data.collection = socket.url
							Data.document = {_id: Data._id}
							indexeddb.deleteDocument(Data)
						}
				})
			}
		},
		
		send (module, data) {
			return new Promise((resolve, reject) => {
				if (!data['timeStamp'])
					data['timeStamp'] = new Date().toISOString()

	            if(!data['organization_id'])
	                data['organization_id'] = this.config.organization_id;
	            
	            if(!data['apiKey'])
	                data['apiKey'] = this.config.apiKey;
	        
				if(!data['user_id'])
	                data['user_id'] = this.config.user_id;
	        
	            if(data['broadcastSender'] === undefined)
	                data['broadcastSender'] = true;
	            
	            if(!data['uid'])
	                data['uid'] = uuid.generate();
	            
	            if(!data['clientId'])
	                data['clientId'] = this.clientId;;
	            

				const uid = data['uid'];
				const sockets = this.getSockets(data);

				let online = true;
				if (isBrowser && !window.navigator.onLine)
					online = false
				
				for (let socket of sockets) {
					if (socket && socket.connected && online) {
						socket.send(JSON.stringify({ module, data }));
						if (data.status != "received locally")
							data.status = "sent"
						if (isBrowser) {
							window.addEventListener(uid, function(event) {
								resolve(event.detail);
							}, { once: true });
						} else {
							process.once(uid, (data) => {
								resolve(data);
							});
						}
					} else {
						if (data.status != "received locally")
							data.status = "queued"
						if (!isBrowser)
							this.messageQueue.set(uid, {module, data});
						else {
							indexeddb.createDocument({
								database: 'socketMessageQueue',
								collection: socket.url,
								document: { _id: uid, module: module, document: data }
							})
						}
					}
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
		
		getUrls(data = {}) {
			let w_protocol = ''
			if (isBrowser) {
				w_protocol = window.location.protocol;		
				if (window.location.protocol === "about:")
					w_protocol = window.parent.location.protocol;
			}
			let protocol = w_protocol === 'http:' ? 'ws' : 'wss';
			let port = data.port || this.config.port || '';
			let url, urls = [];
			let hosts = data.host || this.config.host		
			let balancer = data.balancer || this.config.balancer	
			if (hosts) {
				// ToDo: loadbalancer type eg. mesh, closest
				if (Array.isArray(hosts)) {
					if (balancer != "mesh") {
						hosts = [hosts[0]]
					}
				} else {
					hosts = [hosts]
				}

				for (let host of hosts) {
					if (host.includes("://")) {
						url = `${host}`;
					} else {
						if (host.includes(":")) {
							url = `${protocol}://${host}`;
						} else {
							url = `${protocol}://${host}${port}`;	
						}
					}
					url = this.addSocketPath(data, url)
					urls.push(url)
				}
			} else if (isBrowser) {
				url = [`${protocol}://${window.location.host}${port}/`];
				url = this.addSocketPath(data, url)
				urls.push(url)
			} else {
				return console.log('missing host')
			}

			return urls;
		},
		
		addSocketPath(data, url) {
			let prefix = data.prefix || 'ws';
			let organization_id = data.organization_id || this.config.organization_id;
			let namespace = data.namespace || '';
			let room = data.room || '';
			if (prefix && prefix != '')
				url += `/${prefix}`
			if (organization_id && organization_id != '')
				url += `/${organization_id}`
			if (namespace && namespace != '')
				url += `/${namespace}`
			if (room && room != '')
				url += `/${room}`
			return url
		},

		getSockets(data) {
			let sockets = [];
			let urls = this.getUrls(data)
			for (let url of urls) {
				let socket = this.sockets.get(url)
				if (!socket) {
					this.create(data)
					socket = {url: url}
				} else {
					sockets.push(socket)
				}
			}
			return sockets;		
		},
			
	}
    return CoCreateSocketClient;
})
);
