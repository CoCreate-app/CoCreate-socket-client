import {getCommonParams, getCommonParamsExtend, generateSocketClient} from './common-fun.js';

class CoCreateSocket
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
		const {namespace, room} = config;
		const key = this.getKey(namespace, room);
		let _this = this;
		let socket;
		if (this.sockets.get(key)) {
			socket = this.sockets.get(key);
			console.log('SOcket already has been register');
			return;
		}
		
		let w_protocol = window.location.protocol;		
		if (window.location.protocol === "about:") {
			w_protocol = window.parent.location.protocol;
		}
		let protocol = w_protocol === 'http:' ? 'ws' : 'wss';
		
		const port = config.port ? config.port : 8088;
		
		let socket_url = `${protocol}://${window.location.host}:${port}/${key}`;
		
		if (config.host) {
			if (config.host.includes("://")) {
				socket_url = `${config.host}/${key}`;
			} else {
				socket_url = `${protocol}://${config.host}:${port}/${key}`;
			}
		}
		
		socket = new WebSocket(socket_url);
		
		socket.onopen = function(event) {
			const messages = _this.messageQueue.get(key) || [];
			messages.forEach(msg => socket.send(JSON.stringify(msg)));
			
			_this.sockets.set(key, socket);
			_this.messageQueue.set(key, []);
		}
		
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
		}
		
		socket.onerror = function(err) {
			console.log('Socket error');
			_this.destroy(socket, key);
			_this.reconnect(socket, config);
		}

		socket.onmessage = function(data) {
			
			try {
				if (data.data instanceof Blob) {
					_this.saveFile(data.data);
					return;
				}
				let rev_data = JSON.parse(data.data);
				if (rev_data.data.event) {
					
					var event = new CustomEvent(rev_data.data.event, {
						detail: rev_data.data
					})
					document.dispatchEvent(event);
					return;
				}
				let action = rev_data.action;
				const listeners = _this.listeners.get(rev_data.action);
				if (!listeners) {
					return;
				}
				listeners.forEach(listener => {
					listener(rev_data.data, key);
				})
			} catch (e) {
				console.log(e);
			}
		}
	}
	
	/**
	 * 
	 */
	send (action, data, room) {
		const obj = {
			action: action,
			data: data
		}
		const key = this.getKeyByRoom(room);
		const socket = this.getByRoom(room);
		
		if (socket) {
			socket.send(JSON.stringify(obj));
		} else {
			if (this.messageQueue.get(key)) {
				this.messageQueue.get(key).push(obj);
			} else {
				this.messageQueue.set(key, [obj]);
			}
		}
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
	
	getByRoom(room) {
		let key = this.getKeyByRoom(room)
		return this.sockets.get(key);	
	}
	
	getKeyByRoom(room) {
		let key = this.globalScope;
		if (room) {
			key = `${this.prefix}/${room}`;
		}
		return key;		
	}
	
	
	saveFile(blob) {
		// const {filename} = window.saveFileInfo;
		
		const file_name = this.saveFileName || 'downloadFile';
		var a = document.createElement("a");
        document.body.appendChild(a);
        a.style = "display: none";

        let url = window.URL.createObjectURL(blob);
        a.href = url;
        a.download = file_name;
        a.click();
        window.URL.revokeObjectURL(url);

        this.saveFileName = ''
	}
	
	listenAsync(eventname) {
		return new Promise((resolve) => {
			document.addEventListener(eventname, function(event) {
			    resolve(event.detail);
			}, { once: true })
			
		})
	}
}


export default CoCreateSocket;

