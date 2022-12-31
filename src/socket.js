(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(["@cocreate/uuid", "@cocreate/indexeddb"], function(uuid, indexeddb) {
        	return factory(true, WebSocket, Blob, uuid, indexeddb = indexeddb.default)
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

	const delay = 1000 + Math.floor(Math.random() * 3000)
    const CoCreateSocketClient = {
		connected: false,
		sockets: new Map(),
		listeners: new Map(),
		messageQueue:  new Map(),
		configQueue:  new Map(),
		saveFileName:  '',
		clientId: uuid.generate(8),	
		config: {},
		initialReconnectDelay: delay,
		currentReconnectDelay: delay,
		maxReconnectDelay: 600000,

			
		/**
		 * config: {organization_id, namespace, room, host, port}
		 */
		create(config) {
			const self = this;
			if (isBrowser) {
				if (!config)
					config = {};
				if (!window.CoCreateConfig)
					window.CoCreateConfig = {};
				if (!config.organization_id) {						
					config.organization_id = window.CoCreateConfig.organization_id || window.localStorage.getItem('organization_id')

					if (!config.organization_id) {
						config.organization_id = indexeddb.ObjectId()
						config.apiKey = uuid.generate(32)
						config.user_id = indexeddb.ObjectId()
						window.localStorage.setItem('user_id', config.user_id)					
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
				if (!config.user_id) {
					config.user_id = window.CoCreateConfig.user_id || window.localStorage.getItem('user_id') || ''
					window.localStorage.setItem('user_id', config.user_id) 				
				}
				// if (!config.port) {
				// 	config.port = window.CoCreateConfig.port || window.localStorage.getItem('port') || ''
				// 	window.localStorage.setItem('port', config.port) 				
				// }
				// if (!config.prefix) {
				// 	config.prefix = "ws"; // previously 'crud'
				// }

				if (!window.navigator.onLine && !this.configQueue.has(config)) {
					// ToDo: create a key string using host, org_id tp prevent duplicate events
					// this.configQueue.set(config,'')
					const online = () => {
						window.removeEventListener("online", online)
						// self.configQueue.delete(config)
						self.create(config)
					}
					window.addEventListener("online", online);
				}
				
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
					self.connected = true
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
					
					self.destroy(socket);
					self.reconnect(config);
				};
		
				socket.onmessage = function(message) {
					try {
						if (isBrowser && window.Blob) {
							if (message.data instanceof Blob) {
								self.saveFile(message.data);
								return;
							}
						}
						let {action, data} = JSON.parse(message.data);

						if (action != 'connect' && typeof data == 'object') {
							data.status = "received"
		
							if (data) {
								if (data.uid) {
									self.__fireEvent(data.uid, data);
								}
							}

							if (isBrowser && data.uid && data.broadcastBrowser == 'once') {
								indexeddb.readDocument({
									database: 'socketSync',
									collection: socket.url,
									document: {_id: data.uid}
								}).then((message) => {
									if (!message.document[0]) {
										self.__fireListeners(action, data)
									}	
								})
							} else {
								self.__fireListeners(action, data)
							}
						}
					} catch (e) {
						console.log(e);
					}
				};
	
			}
		},
		
		__fireListeners(action, data) {
			const listeners = this.listeners.get(action);
			if (!listeners) {
				return;
			}
			listeners.forEach(listener => {
				listener(data);
			});
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
					for (let [uid, {action, data}] of this.messageQueue) {
						this.send(action, data)
						this.messageQueue.delete(uid);
					}
				}
			} else {
				indexeddb.readDocument({
					database: 'socketSync',
					collection: socket.url,
				}).then((data) => {
					if (data.document) {
						for (let Data of data.document) {
							if (Data.document.status == 'queued') {
								this.send(Data.action, Data.document)
								Data.document = {_id: Data._id}
								indexeddb.deleteDocument(Data)
							} else if (Data.document.status == 'sent') {
								let messageTime = new Date(Data.document.timeStamp);
								let currentTime = new Date();
								let diff = (currentTime - messageTime) / 1000;
								if (diff > 180) {
									Data.document = {_id: Data._id}
									indexeddb.deleteDocument(Data)
								}
							}
						}
					}
				})
			}
		},
		
		send (action, data) {
			return new Promise((resolve, reject) => {
				if (!data['timeStamp'])
					data['timeStamp'] = new Date().toISOString()

	            if (!data['organization_id'])
	                data['organization_id'] = this.config.organization_id;
	            
	            if (!data['apiKey'])
	                data['apiKey'] = this.config.apiKey;
	        
				if (!data['user_id'])
	                data['user_id'] = this.config.user_id;
	        
	            if (data['broadcast'] === 'false' || data['broadcast'] === false)
	                data['broadcast'] = false;
				else
					data['broadcast'] = true;

	            if (data['broadcastSender'] === 'false' || data['broadcastSender'] === false)
	                data['broadcastSender'] = false;
				else
					data['broadcastSender'] = true;

	            if (!data['uid'])
	                data['uid'] = uuid.generate();
	
	            if (!data['clientId'])
	                data['clientId'] = this.clientId;;

	            if (!data['namespace'])
	                delete data.namespace;

	            if (!data['room'])
	                delete data.room;

				const uid = data['uid'];
				const sockets = this.getSockets(data);

				let online = true;
				if (isBrowser && !window.navigator.onLine)
					online = false
				
				for (let socket of sockets) {
					// ToDo: uid per each socket?
					let status = data.status
					if (status != "queued") {
						if (isBrowser) {
							window.addEventListener(uid, function(event) {
								resolve(event.detail);
							}, { once: true });
						} else {
							process.once(uid, (data) => {
								resolve(data);
							});
						}
					}

					if (socket && socket.connected && online) {
						delete data.status
						socket.send(JSON.stringify({ action, data }));
						data.status = "sent"
					} else {
						data.status = "queued"
						if (!isBrowser)
							this.messageQueue.set(uid, {action, data});
					}

					if (isBrowser && (data.status == "queued" || data.broadcastBrowser != false && data.broadcastBrowser != 'false')) {
						const self = this

						if (data.db && data.db.includes('indexeddb')) {
							let type = action.match(/[A-Z][a-z]+/g);
							type = type[0].toLowerCase()
							if (type && data[type] && data[type][0])
								resolve(data);
						}

						indexeddb.createDocument({
							database: 'socketSync',
							collection: socket.url,
							document: { _id: uid, action, document: data }
						}).then(() => {
							if (action !== 'readDocument') {
								if (data.broadcastSender !== false)
									self.sendLocalMessage(action, data)
								if (data.broadcastBrowser != false || data.broadcastBrowser != 'false') {
									let browserMessage = { 
										action, 
										data: {
											database: 'socketSync',
											collection: socket.url,
											document: { _id: uid },
											clientId: this.clientId
										}
									}
									window.localStorage.setItem('localSocketMessage', JSON.stringify(browserMessage))
								}
							}
						})
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
	
		listen(action, callback) {
			if (!this.listeners.get(action)) {
				this.listeners.set(action, [callback]);
			} else {
				this.listeners.get(action).push(callback);
			}
		},

		reconnect(config) {
			let self = this;

			setTimeout(() => {
				if (!self.maxReconnectDelay || self.currentReconnectDelay < self.maxReconnectDelay) {
					self.currentReconnectDelay*=2;
					self.create(config);
				}
			}, self.currentReconnectDelay);
			
		},
		
		destroy(socket) {
			if (socket) {
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
					socket = this.sockets.get(url)
					if (socket)
						sockets.push(socket)
				} else {
					sockets.push(socket)
				}
			}
			return sockets;		
		},
		
		sendLocalMessage(action, data) {
			if (action == 'sendMessage')
				action = data.message
			this.__fireListeners(action, data)
		}	
	}

	if (isBrowser) {
		window.onstorage = (e) => {
			if (e.key == 'localSocketMessage') {
				let Data = JSON.parse(e.newValue)
				
				indexeddb.readDocument(Data.data).then((data) => {
					if (data.document[0]) {
						CoCreateSocketClient.sendLocalMessage(data.document[0].action, data.document[0].document);
					}
				})			
	
			}
		};  
	}          


    return CoCreateSocketClient;
})
);