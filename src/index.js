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
			this.clientId = uuid.generate(8);
			this.config = {}
			this.initialReconnectDelay = 1000 + Math.floor(Math.random() * 3000);
			this.currentReconnectDelay = this.initialReconnectDelay;
			this.maxReconnectDelay = 600000;

		}
			
		/**
		 * config: {namespace, room, host}
		 */
		create (config) {
			const self = this;
			if ( window && !window.navigator.onLine){
				window.addEventListener("online", this.online);
			}

			if (window) {
				if (!config)
					config = {};
				if (!window.config)
					window.config = {};
				if (!config.organization_id) {
					config.organization_id = window.config.organization_id || window.localStorage.getItem('organization_id') || this.ObjectId()		
					window.localStorage.setItem('organization_id', config.organization_id) 
				}
				if (!config.apiKey) {
					config.apiKey = window.config.apiKey || window.localStorage.getItem('apiKey') || uuid.generate(32)
					window.localStorage.setItem('apiKey', config.apiKey) 				
				}
				if (!config.host) {
					config.host = window.config.host || window.localStorage.getItem('host') || window.location.hostname
					window.localStorage.setItem('host', config.host) 				
				}
				this.config = config
				window.config = config;
			}			
			
			const key = this.getKey(config);
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
				socket.clientId = this.clientId;
				socket.key = key;
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
						self.reconnect(config);
						break;
				}
			};
			
			socket.onerror = function(err) {
				console.log(err.message);
				self.destroy(socket, key);
				self.reconnect(config);
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
					for (let [request_id, {module, data}] of this.messageQueue) {
						this.send(module, data)
						this.messageQueue.delete(request_id);
					}
				}
			}
			else {
				indexeddb.readDocuments({
					database: 'internalStrorage',
					collection: 'socketMessageQueue',
				}).then((data) =>{
					if (data.data)
						for (let Data of data.data) {
							this.send(Data.module, Data.data)
							Data.database = 'internalStrorage'
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
	                data['organization_id'] = this.config.organization_id;
	            }
	            if(!data['apiKey']) {
	                data['apiKey'] = this.config.apiKey;
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
							database: 'internalStrorage',
							collection: 'socketMessageQueue',
							data: {_id: request_id, module: module, data: data}
						})
					}
					resolve(data)
				}
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

		reconnect(config) {
			let self = this;
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
			
			this.sockets.delete(key);
		}
		
		getKey(data) {
			let key = this.prefix;
			let namespace = data.namespace || this.config.organization_id;
			let room = data.room || '';
			if (room &&  room != '')
				key += `/${namespace}/${room}`
			else
				key +=`/${namespace}`;

			return key;
		}
		
		getSocket(data) {
			let key = this.getKey(data)
			return this.sockets.get(key);	
		}
				
		ObjectId = (rnd = r16 => Math.floor(r16).toString(16)) =>
    		rnd(Date.now()/1000) + ' '.repeat(16).replace(/./g, () => rnd(Math.random()*16));


	}
    return CoCreateSocketClient;
}));
