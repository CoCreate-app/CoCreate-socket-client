/********************************************************************************
 * Copyright (C) 2023 CoCreate and Contributors.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 ********************************************************************************/

/**
 * Commercial Licensing Information:
 * For commercial use of this software without the copyleft provisions of the AGPLv3,
 * you must obtain a commercial license from CoCreate LLC.
 * For details, visit <https://cocreate.app/licenses/> or contact us at sales@cocreate.app.
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(["@cocreate/uuid", "@cocreate/indexeddb", "@cocreate/local-storage"], function (uuid, indexeddb, localStorage) {
            return factory(true, WebSocket, Blob, uuid, indexeddb = indexeddb.default, localStorage = localStorage.default)
        });
    } else if (typeof module === 'object' && module.exports) {
        const ws = require("ws")
        const uuid = require("@cocreate/uuid");
        module.exports = factory(false, ws, null, uuid);
    } else {
        // Browser globals (root is window)
        root.returnExports = factory(true, WebSocket, Blob, root["@cocreate/uuid"], root["@cocreate/indexeddb"], root["@cocreate/local-storage"]);
    }
}(typeof self !== 'undefined' ? self : this, function (isBrowser, WebSocket, Blob, uuid, indexeddb, localStorage) {

    const socketsByKey = new Map()
    const socketsById = new Map()
    const delay = 1000 + Math.floor(Math.random() * 3000)
    const CoCreateSocketClient = {
        connected: false,
        listeners: new Map(),
        messageQueue: new Map(), // required per url already per url when isBrowser and indexeddb
        configQueue: new Map(),
        clientId: '',
        config: {},
        initialReconnectDelay: delay, // required per url
        currentReconnectDelay: delay, // required per url
        maxReconnectDelay: 600000, // required per url
        organization: false, // required per url
        serverDB: true, // required per url
        serverOrganization: true, // required per url
        syncedMessages: [], // required per url and needs to be persistent
        lastSynced: '', // required per url and needs to be persistent

        //TODO: on app start up we can get the port and ip and public dns. using config we can define if this app is behind an lb.
        // If behind an lb it can create a socket connection to the lb node in order to add node to the lb backend list.

        set(socket) {
            socketsByKey.set(socket.key, socket);
            socketsById.set(socket.id, socket);
        },

        get(key) {
            return socketsByKey.get(key) || socketsById.get(key)
        },

        has(key) {
            return socketsByKey.has(key) || socketsById.has(key)
        },

        delete(key) {
            let socket
            if (typeof key === 'string')
                socket = this.get(key)
            if (!socket || !socket.id && !socket.key)
                return
            socketsByKey.delete(socket.key)
            socketsById.delete(socket.id)
            socket.close()
        },

        // TODO: replace with @cocreate/config
        getConfig(key) {
            let value
            if (window.CoCreateConfig && window.CoCreateConfig[key])
                value = window.CoCreateConfig[key]
            else
                value = localStorage.getItem(key)
            return value
        },
        // TODO: replace with @cocreate/config
        setConfig(key, value) {
            if (!window.CoCreateConfig)
                window.CoCreateConfig = { [key]: value }
            else
                window.CoCreateConfig[key] = value
            localStorage.setItem(key, value)
        },
        // TODO: replace with @cocreate/config
        getClientId() {
            this.clientId = this.getConfig('clientId')
            if (!this.clientId) {
                this.clientId = indexeddb.ObjectId()
                this.setConfig('clientId', this.clientId)
            }
        },

        /**
         * config: {organization_id, namespace, room, host}
         */
        async create(config) {
            const self = this;
            if (isBrowser) {

                if (!config)
                    config = {};
                if (!window.CoCreateConfig)
                    window.CoCreateConfig = {};
                if (!config.organization_id) {
                    config.organization_id = this.getConfig('organization_id')
                    if (config.organization_id)
                        this.setConfig('organization_id', config.organization_id)
                    else {
                        let data = await indexeddb.send({ method: 'read.database' })
                        for (let database of data.database) {
                            let name = database.database.name
                            if (name.match(/^[0-9a-fA-F]{24}$/)) {
                                config.organization_id = name
                                this.setConfig('organization_id', name)
                                break;
                            }
                        }

                        if (!config.organization_id) {
                            if (navigator.serviceWorker) {
                                navigator.serviceWorker.addEventListener("message", (event) => {
                                    if (event.data.action === 'getOrganiztion') {
                                        config.organization_id = event.data.organization_id
                                        if (!config.organization_id)
                                            this.createOrganization(config).then((config) => {
                                                if (config)
                                                    self.create(config)
                                            });
                                        else {
                                            self.setConfig('organization_id', config.organization_id)
                                            self.create(config)
                                        }
                                    }
                                });

                                // Send message to SW
                                const msg = new MessageChannel();
                                return navigator.serviceWorker.ready.then(() => {
                                    navigator.serviceWorker.controller.postMessage("getOrganization", [msg.port1]);
                                })
                            } else
                                config = await this.createOrganization(config)

                        }
                    }

                }
                if (!config.apikey) {
                    config.apikey = this.getConfig('apikey')
                    this.setConfig('apikey', config.apikey)
                }
                if (!config.host) {
                    config.host = this.getConfig('host') || window.location.host
                    this.setConfig('host', config.host)
                }
                if (!config.user_id) {
                    config.user_id = this.getConfig('user_id') || ''
                    this.setConfig('user_id', config.user_id)
                }
                if (!config.balancer) {
                    config.balancer = this.getConfig('balancer') || ''
                    this.setConfig('balancer', config.balancer)
                }
                if (!config.prefix) {
                    config.prefix = this.getConfig('prefix') || 'ws'
                    this.setConfig('prefix', config.prefix)
                }

                if (!window.navigator.onLine && !this.configQueue.has(config)) {
                    // TODO: create a key string using host, org_id to prevent duplicate events
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
            for (let url of urls) {
                let socket = this.get(url);
                if (socket)
                    return;

                try {
                    let token = null;
                    if (isBrowser) {
                        token = this.getConfig("token");
                    }

                    const Config = {
                        socketId: uuid.generate(8),
                        clientId: this.clientId,
                        lastSynced: this.lastSynced, // config.get('lastSynced')  using config to ensure accesiblity through fallbacks
                        syncedMessages: this.syncedMessages // has to have indexeddb to sync else where would the return data sync to. config.get('syncedMessage')  using config to ensure accesiblity through fallbacks
                    }

                    let urlEncodedString = encodeURIComponent(JSON.stringify(Config));
                    if (urlEncodedString)
                        urlEncodedString = `${url}/${urlEncodedString}`
                    else
                        urlEncodedString = url

                    socket = new WebSocket(urlEncodedString, token)
                    socket.id = Config.socketId;
                    socket.connected = false;
                    socket.clientId = this.clientId;
                    socket.organization_id = config.organization_id;
                    socket.user_id = config.user_id;
                    socket.host = config.host;
                    socket.prefix = config.prefix || 'ws';
                    socket.config = { ...config };
                    socket.key = url;

                    this.set(socket);
                } catch (error) {
                    console.log(error);
                    return;
                }

                socket.onopen = function (event) {
                    self.connected = true
                    socket.connected = true;
                    config.url = socket.url
                    config.key = socket.key
                    self.currentReconnectDelay = self.initialReconnectDelay
                    if (config.balancer != "mesh" && config.previousKey && config.previousKey !== socket.key)
                        self.checkMessageQueue(config);
                    else
                        self.checkMessageQueue(config);
                };

                socket.onclose = function (event) {
                    socket.connected = false;

                    switch (event.code) {
                        case 1000: // close normal
                            console.log("websocket: closed");
                            break;
                        default:
                            self.reconnect(config, socket);
                            break;
                    }
                };

                socket.onerror = function (event) {
                    if (!isBrowser)
                        console.log(event.error);
                    else if (!window.navigator.onLine)
                        console.log("offline");

                    self.reconnect(config, socket);
                };

                socket.onmessage = function (message) {
                    try {
                        if (isBrowser && window.Blob) {
                            if (message.data instanceof Blob) {
                                self.saveFile(message.data);
                                return;
                            }
                        }

                        let data = JSON.parse(message.data);
                        if (data.method === 'Access Denied' && data.permission) {
                            if (data.permission.storage === false)
                                self.serverDB = false
                            if (data.permission.organization === false)
                                self.serverOrganization = false
                            console.log(data.permission.error)
                        }

                        if (data.method != 'connect' && typeof data == 'object') {
                            if (isBrowser && indexeddb && data.syncedMessage)
                                self.syncedMessages.push(data.syncedMessage) // needs to be persistent
                            else if (!isBrowser && data.syncedMessage && data.isRegionalStorage)
                                console.log('Multi-master regional database')

                            if (method === 'sync') {
                                self.lastSynced = data.lastSynced
                                if (data.syncedMessages)
                                    self.syncedMessages = self.syncedMessages.filter(item => !data.syncedMessages.includes(item));
                            }

                            data.status = "received"

                            if (data && data.uid) {
                                self.__fireEvent(data.uid, data);
                            }

                            self.__fireListeners(data.method, data)
                        }
                    } catch (e) {
                        console.log(e);
                    }
                };

            }
        },

        createOrganization: async function (config) {
            let createOrganization = document.querySelector('[actions*="createOrganization"]')

            if (this.organization == 'canceled' || this.organization == 'pending') return

            if (!createOrganization && confirm("An organization_id could not be found, if you already have an organization_id add it to this html and refresh the page.\n\nOr click 'OK' create a new organization") == true) {
                this.organization = 'pending'
                if (indexeddb) {
                    try {
                        const Organization = await import('@cocreate/organizations')

                        let org = { object: {} }
                        if (config.organization_id)
                            org.object._id = config.organization_id
                        let { organization, apikey, user } = await Organization.generateDB(org)
                        if (organization && apikey && user) {
                            config.organization_id = organization._id
                            config.apikey = apikey
                            config.user_id = user._id
                            this.setConfig('organization_id', organization._id)
                            this.setConfig('apikey', apikey)
                            this.setConfig('user_id', user._id)
                            this.organization = true
                            return config
                        }
                    } catch (error) {
                        console.error('Failed to load the script:', error);
                    }
                }
            } else {
                this.organization = 'canceled'
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

        // TODO: could be rquired in the serverside when handeling server to server mesh socket
        checkMessageQueue(config) {
            let socketKey = config.previousKey || config.key
            if (isBrowser && indexeddb) {
                // TODO: read and delete atomically to enforce the message is sent once per client
                indexeddb.send({
                    method: 'read.object',
                    database: 'socketSync',
                    array: socketKey,
                }).then((data) => {
                    if (data.object) {
                        for (let Data of data.object) {
                            if (Data.status == 'queued') {
                                if (config.previousKey)
                                    Data.previousKey = config.previousKey


                                indexeddb.send({
                                    method: 'delete.object',
                                    database: 'socketSync',
                                    array: socketKey,
                                    object: { _id: Data._id }
                                })

                                this.send(Data)
                            }
                        }
                    }
                })
            } else {
                // TODO: set and get messageQueue per socket.key 
                if (this.messageQueue.size > 0) {
                    for (let [uid, data] of this.messageQueue) {
                        this.send(data)
                        this.messageQueue.delete(uid);
                    }
                }
            }
        },


        send(data) {
            return new Promise((resolve, reject) => {
                data.clientId = this.clientId;

                if (!data['timeStamp'])
                    data['timeStamp'] = new Date();

                if (!data['organization_id'])
                    data['organization_id'] = this.config.organization_id;

                if (!data['apikey'] && this.config.apikey)
                    data['apikey'] = this.config.apikey;

                if (!data['user_id'] && this.config.user_id)
                    data['user_id'] = this.config.user_id;

                if (data['broadcast'] === 'false' || data['broadcast'] === false)
                    data['broadcast'] = false;
                else
                    data['broadcast'] = true;

                if (data['broadcastClient'] && data['broadcastClient'] !== 'false')
                    data['broadcastClient'] = true;
                else
                    data['broadcastClient'] = false;

                if (data['broadcastSender'] === 'false' || data['broadcastSender'] === false)
                    data['broadcastSender'] = false;
                else
                    data['broadcastSender'] = true;

                if (!data['uid'])
                    data['uid'] = uuid.generate();

                if (!data['namespace'])
                    delete data.namespace;

                if (!data['room'])
                    delete data.room;

                let broadcastBrowser = false
                if (data['broadcastBrowser'] && data['broadcastBrowser'] !== 'false') {
                    broadcastBrowser = true;
                    delete data['broadcastBrowser']
                }

                let online = true;
                if (isBrowser && !window.navigator.onLine)
                    online = false

                const uid = data['uid'];
                const sockets = this.getSockets(data);

                for (let socket of sockets) {
                    data.socketId = socket.id;

                    let status = data.status
                    if (status != "queued") {
                        if (isBrowser) {
                            window.addEventListener(uid, function (event) {
                                resolve(event.detail);
                            }, { once: true });
                        } else {
                            process.once(uid, (data) => {
                                resolve(data);
                            });
                        }
                    }

                    let token
                    if (isBrowser)
                        token = this.getConfig("token");

                    if (this.serverOrganization && (this.serverDB
                        || token && data.method.includes('object') && data.array && (data.array.includes('organizations')
                            || data.array.includes("users")) ||
                        ['signIn', 'addOrg'].includes(data.method))) {
                        if (socket && socket.connected && online) {
                            delete data.status
                            socket.send(JSON.stringify(data));
                            data.status = "sent"
                        } else {
                            data.status = "queued"
                            if (!isBrowser || !indexeddb)
                                this.messageQueue.set(uid, data);
                        }
                    } else
                        data.status = "queued"

                    if (isBrowser && !data.method.startsWith('read')) {
                        if (data.broadcastSender)
                            this.sendLocalMessage(data)
                        if (broadcastBrowser)
                            this.setConfig('localSocketMessage', JSON.stringify(data))
                    }

                    if (isBrowser && indexeddb && data.status == "queued") {
                        if (data.storage && data.storage.includes('indexeddb')) {
                            let type = data.method.split('.');
                            type = type[type.length - 1];

                            if (type && data[type]) {
                                if (data[type].length || !this.serverOrganization || !this.serverDB || !socket.connected)
                                    resolve(data);
                            }
                        }

                        indexeddb.send({
                            method: 'create.object',
                            database: 'socketSync',
                            array: socket.key,
                            object: { _id: uid, ...data }
                        })
                    }
                }
            });
        },

        sendFile(file, room) {
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

        reconnect(config, socket) {
            let self = this;
            let key = socket.key

            setTimeout(() => {
                if (!self.maxReconnectDelay || self.currentReconnectDelay < self.maxReconnectDelay) {
                    if (config.balancer !== 'mesh') {
                        config.previousKey = key
                        self.delete(key)
                    }
                    self.currentReconnectDelay *= 2;
                    self.create(config);
                }
            }, self.currentReconnectDelay);

        },

        getUrls(data = {}) {
            let protocol = 'wss';
            if (isBrowser && location.protocol !== "https:")
                protocol = "ws";

            let url, urls = [], hostUrls = [];
            let host = data.host || this.config.host
            let balancer = data.balancer || this.config.balancer
            if (typeof host === 'string') {
                host = host.split(",");
                for (let i = 0; i < host.length; i++) {
                    host[i] = host[i].trim()
                    if (host[i][host[i].length - 1] === '/')
                        host[i] = host[i].slice(0, -1)

                    if (host[i].includes("://"))
                        url = `${host[i]}`;
                    else
                        url = `${protocol}://${host[i]}`;

                    url = this.addSocketPath(data, url)
                    if (balancer == "mesh")
                        urls.push(url)
                    else {
                        let socket = this.get(url)
                        if (socket !== false) {
                            urls.push(url)
                            break;
                        } else
                            hostUrls.push(url)
                    }
                }
                if (!urls.length && hostUrls.length) {
                    for (let i = 0; i < hostUrls.length; i++) {
                        this.delete(hostUrls[i])
                        urls.push(hostUrls[i])
                    }

                }
            } else if (isBrowser) {
                url = [`${protocol}://${window.location.host}`];
                url = this.addSocketPath(data, url)
                urls.push(url)
            } else {
                console.log('missing host')
            }

            return urls;
        },

        addSocketPath(data, url) {
            let prefix = data.prefix || this.config.prefix || 'ws';
            if (prefix && prefix != '')
                url += `/${prefix}`

            let organization_id = data.organization_id || this.config.organization_id;
            if (organization_id)
                url += `/${organization_id}`

            return url
        },


        getSockets(data) {
            let sockets = [];
            let urls = this.getUrls(data)
            for (let url of urls) {
                let socket = this.get(url)
                if (!socket) {
                    this.create(data)
                    socket = this.get(url)
                    if (socket)
                        sockets.push(socket)
                } else {
                    sockets.push(socket)
                }
            }
            return sockets;
        },

        sendLocalMessage(data) {
            if (data.method == 'sendMessage')
                data.method = data.message
            this.__fireListeners(data.method, data)
        }
    }

    if (isBrowser) {
        CoCreateSocketClient.getClientId()

        window.onstorage = (e) => {
            if (e.key == 'localSocketMessage' && indexeddb && e.newValue) {
                let data = JSON.parse(e.newValue)
                CoCreateSocketClient.sendLocalMessage(data)
            }
        };
    }


    return CoCreateSocketClient;
})
);
