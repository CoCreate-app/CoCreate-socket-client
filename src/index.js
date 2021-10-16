(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(["@cocreate/uuid"], function(uuid) {
        	return factory(window, WebSocket, Blob, uuid)
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
        root.returnExports = factory(window, WebSocket, Blob, root["@cocreate/socket-client"]);
  }
}(typeof self !== 'undefined' ? self : this, function (wnd, WebSocket, Blob, uuid) {

    class CoCreateSocketClient
	{
		constructor(prefix = "crud") {
			this.prefix = prefix || "crud";
			this.sockets = new Map();
			this.listeners = new Map();
			this.messageQueue =  new Map();
			this.saveFileName =  '';
			this.globalScope =  "";
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
			
			let {namespace, room} = config;
			if (!namespace)
				namespace = config.organization_Id
			const key = this.getKey(namespace, room);
			let _this = this;
			if (namespace) {
				this.setGlobalScope(namespace)
			}
			
			let socket;
			if (this.sockets.get(key)) {
				socket = this.sockets.get(key);
				// console.log('SOcket already has been register');
				return;
			}
			
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
				socket.cocreate_connected = false;
				this.sockets.set(key, socket);
			} catch(error) {
				console.log(error);
				return;
			}

			socket.onopen = function(event) {
				if (!socket.cocreate_connected) {
					socket.cocreate_connected = true;
				}
				_this.checkMessageQueue();
			};
			
			socket.onclose = function(event) {
				switch(event.code) {
					case 1000: // close normal
						console.log("websocket: closed");
						break;
					default: 
						_this.destroy(socket, key);
						_this.reconnect(socket, config);
						break;
				}
			};
			
			socket.onerror = function(err) {
				console.log(err.message);
				_this.destroy(socket, key);
				_this.reconnect(socket, config);
			};
	
			socket.onmessage = function(data) {
				try {
					if (wnd.Blob) {
						if (data.data instanceof Blob) {
							_this.saveFile(data.data);
							return;
						}
					}
					let rev_data = JSON.parse(data.data);
					
					if (rev_data.data) {
						
						if (rev_data.data.uid) {
							_this.__fireEvent(rev_data.data.uid, rev_data.data);
						}
						if (rev_data.data.event) {
							_this.__fireEvent(rev_data.data.event, rev_data.data);
							return;
						}
						
					}
					const listeners = _this.listeners.get(rev_data.action);
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
			if (this.messageQueue.size > 0){
				for (let [request_id, {channel, obj}] of this.messageQueue) {
					const socket = this.getSocket(channel);
					if (socket && socket.cocreate_connected) {
						socket.send(JSON.stringify(obj));
						this.messageQueue.delete(request_id);
					}
				}
			}
		}
		
		send (action, data, room) {
			return new Promise((resolve, reject) => {
				const request_id = uuid.generate();
				const channel = this.getChannel(data);
				const socket = this.getSocket(channel);
				
	            if(data['broadcast_sender'] === undefined) {
	                data['broadcast_sender'] = true;
	            }
	            
				const obj = {
					action: action,
					data: {...data, uid: request_id}
				};
				if (!wnd.document)
				    obj.data['event'] = request_id;

				if (socket && socket.cocreate_connected) {
					socket.send(JSON.stringify(obj));
				} else {
					this.messageQueue.set(request_id, {channel, obj});
				}
				if (wnd.document) { //. browser case
						wnd.addEventListener(request_id, function(event) {
						    resolve(event.detail);
						}, { once: true });
				} else { //. node case
					process.once(request_id, (data) => {
						resolve(data);
					});
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
		
		// ToDo: Apply a backoff 
		reconnect(socket, config) {
			let _this = this;
			setTimeout(function() {
				_this.create(config);
			}, 1000)
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
		
		getSocket(channel) {
			let key = this.globalScope;
			if (channel) {
				key = `${this.prefix}/${channel}`;
			}			
			return this.sockets.get(key);	
		}
		
		getCommonParams(info) {
			let config = {};
			if (wnd && wnd.config) config = wnd.config;

			return {
				"apiKey": info.apiKey || config.apiKey,
				"organization_id": info.organization_id || config.organization_Id,
			};
		}

		getChannel(data) {
			let config = {};
			if (wnd && wnd.config) config = wnd.config;

			let ns = data.namespace || config.organization_Id;
			let rm = data.room || '';
			if (rm) {
				return `${ns}/${rm}`;
			}
			else {
				return ns;
			}
		}
	}
    return CoCreateSocketClient;
}));
