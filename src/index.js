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
        define(["@cocreate/uuid", "@cocreate/indexeddb", "@cocreate/config"], function (uuid, indexeddb, configHandler) {
            return factory(true, WebSocket, uuid, indexeddb = indexeddb.default, configHandler = configHandler.default)
        });
    } else if (typeof module === 'object' && module.exports) {
        const WebSocket = require("ws")
        const uuid = require("@cocreate/uuid");
        module.exports = factory(false, WebSocket, uuid);
    } else {
        // Browser globals (root is window)
        root.returnExports = factory(true, WebSocket, root["@cocreate/uuid"], root["@cocreate/indexeddb"], root["@cocreate/config"]);
    }
}(typeof self !== 'undefined' ? self : this, function (isBrowser, WebSocket, uuid, indexeddb, configHandler) {
    const socketsByUrl = new Map()
    const socketsById = new Map()
    const delay = 1000 + Math.floor(Math.random() * 3000)
    const CoCreateSocketClient = {
        connected: false,
        listeners: new Map(),
        messageQueue: new Map(), // required per url already per url when isBrowser and indexeddb
        configQueue: new Map(),
        config: {},
        initialReconnectDelay: delay, // required per url
        currentReconnectDelay: delay, // required per url
        maxReconnectDelay: 600000, // required per url
        organization: false, // required per url
        serverDB: true, // required per url
        serverOrganization: true, // required per url

        //TODO: on app start up we can get the port and ip and public dns. using config we can define if this app is behind an lb.
        // If behind an lb it can create a socket connection to the lb node in order to add node to the lb backend list.

        async init() {
            const defaults = { clientId: indexeddb.ObjectId(), host: window.location.host }
            const keys = ['clientId', 'organization_id', 'apikey', 'host', 'user_id', 'balancer']
            for (let i = 0; i < keys.length; i++) {
                this.config[keys[i]] = configHandler.get(keys[i]) || defaults[keys[i]] || ''
                if (!this.config[keys[i]] && keys[i] === 'organization_id')
                    this.config[keys[i]] = await this.getOrganization()
                configHandler.set(keys[i], this.config[keys[i]])
                if (keys[i] === 'clientId')
                    this.clientId = this.config[keys[i]]
            }
        },

        set(socket) {
            socketsByUrl.set(socket.url, socket);
            socketsById.set(socket.id, socket);
        },

        get(key) {
            return socketsByUrl.get(key) || socketsById.get(key)
        },

        has(key) {
            return socketsByUrl.has(key) || socketsById.has(key)
        },

        delete(key) {
            let socket
            if (typeof key === 'string')
                socket = this.get(key)
            if (!socket || !socket.id && !socket.url)
                return
            socketsByUrl.delete(socket.url)
            socketsById.delete(socket.id)
            if (socket.close)
                socket.close()
        },

        /**
         * config: {organization_id, namespace, room, host}
         */
        async create(config = {}) {
            const self = this;
            if (!config.organization_id && !this.config.organization_id)
                return console.log('organization_id not found and config should be added to a queue until organization_id is created')

            if (isBrowser && !window.navigator.onLine && !config.clientId) {
                const online = () => {
                    window.removeEventListener("online", online)
                    self.create(config)
                }
                window.addEventListener("online", online);
                return
            }

            const urls = this.getUrls(config);
            for (let url of urls) {
                let socket = this.get(url);
                if (socket)
                    return;

                this.set({ url });

                try {

                    let token = null;
                    if (isBrowser) {
                        token = configHandler.get("token");
                    }

                    const options = {
                        socketId: uuid.generate(8),
                        clientId: this.clientId,
                        token: token || ''
                    }

                    // indexeddb required to sync else where would the return data sync to?
                    if (isBrowser && indexeddb) {
                        let data = await indexeddb.send({
                            method: 'read.object',
                            database: 'socketSync',
                            array: url,
                            filter: {
                                query: [
                                    { key: 'type', value: 'lastSynced', operator: '$eq' }
                                ]
                            }
                        })

                        if (data && data.object && data.object[0]) {
                            console.log('Config', data.object[0])
                            options.lastSynced = data.object[0].lastSynced
                            options.syncedMessages = data.object[0].syncedMessages
                            // TODO: create an array called message_log with type queued, sent, received.
                        }
                    }

                    let opt = JSON.stringify(options)
                    opt = encodeURIComponent(opt)
                    socket = new WebSocket(url, opt)
                    socket.id = options.socketId;
                    socket.connected = false;
                    socket.clientId = this.clientId;
                    socket.organization_id = config.organization_id || this.config.organization_id;
                    socket.user_id = config.user_id || this.config.user_id;
                    socket.host = config.host || this.config.host;
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
                    self.currentReconnectDelay = self.initialReconnectDelay
                    if (config.balancer != "mesh" && config.previousUrl && config.previousUrl !== socket.url)
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
                        let data = JSON.parse(message.data);
                        if (data.method === 'Access Denied' && data.permission) {
                            if (data.permission.storage === false)
                                self.serverDB = false
                            if (data.permission.organization === false)
                                self.serverOrganization = false
                            console.log(data.permission.error)
                        }

                        if (data.method != 'connect' && typeof data == 'object') {
                            if (isBrowser && indexeddb && data.method === 'sync') {

                                indexeddb.send({
                                    method: 'update.object',
                                    database: 'socketSync',
                                    array: socket.url,
                                    object: { lastSyned: data.lastSynced, type: 'lastSynced' },
                                    filter: {
                                        query: [
                                            { key: 'type', value: 'lastSynced', operator: '$eq' }
                                        ]
                                    },
                                    upsert: true
                                })

                                if (data.syncedMessages && data.syncedMessages.length) {
                                    indexeddb.send({
                                        method: 'delete.object',
                                        database: 'socketSync',
                                        array: socket.url,
                                        object: { _id: data.syncedMessage, type: 'synced' },
                                        filter: {
                                            query: [
                                                { key: '_id', value: data.syncedMessages, operator: '$includes' },
                                                { key: 'type', value: 'synced', operator: '$eq' }
                                            ]
                                        }
                                    })
                                }
                                return
                            }

                            if (isBrowser && indexeddb && data.syncedMessage) {
                                indexeddb.send({
                                    method: 'create.object',
                                    database: 'socketSync',
                                    array: socket.url,
                                    object: { _id: data.syncedMessage, type: 'synced' }
                                })
                            } else if (!isBrowser && data.syncedMessage && data.isRegionalStorage)
                                console.log('Multi-master regional database')


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

        async getOrganization() {
            let data = await indexeddb.send({ method: 'read.database' })
            for (let database of data.database) {
                let name = database.database.name
                if (name.match(/^[0-9a-fA-F]{24}$/)) {
                    return name
                }
            }

            let orgainization_id = await getOrganizationFromServiceWorker()
            if (orgainization_id)
                return orgainization_id
            else
                return await this.createOrganization()
        },

        async getOrganizationFromServiceWorker() {
            return new Promise((resolve, reject) => {
                if (!navigator.serviceWorker)
                    return resolve()

                const handleMessage = (event) => {
                    if (event.data.action === 'getOrganization') {
                        navigator.serviceWorker.removeEventListener('message', handleMessage); // Remove the event listener
                        resolve(event.data.organization_id);
                    }
                };

                navigator.serviceWorker.addEventListener('message', handleMessage);

                // Send message to Service Worker
                const msg = new MessageChannel();
                navigator.serviceWorker.ready
                    .then(() => {
                        navigator.serviceWorker.controller.postMessage('getOrganization', [msg.port1]);
                    })
                    .catch(reject);
            });
        },

        async createOrganization() {
            let createOrganization = document.querySelector('[actions*="createOrganization"]')

            if (this.organization == 'canceled' || this.organization == 'pending') return

            if (!createOrganization && confirm("An organization_id could not be found, if you already have an organization_id add it to this html and refresh the page.\n\nOr click 'OK' create a new organization") == true) {
                this.organization = 'pending'
                if (indexeddb) {
                    try {
                        const Organization = await import('@cocreate/organizations')

                        let org = { object: {} }
                        let { organization, apikey, user } = await Organization.generateDB(org)
                        if (organization && apikey && user) {
                            this.config.organization_id = organization._id
                            this.config.apikey = apikey
                            this.config.user_id = user._id
                            configHandler.set('organization_id', organization._id)
                            configHandler.set('apikey', apikey)
                            configHandler.set('user_id', user._id)
                            this.organization = true
                            return organization._id
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

        // TODO: could be rquired in the serverside when handeling server to server mesh socket using crud-server instead
        checkMessageQueue(config) {
            let url = config.previousUrl || config.url
            if (isBrowser && indexeddb) {
                indexeddb.send({
                    method: 'delete.object',
                    database: 'socketSync',
                    array: url,
                    filter: {
                        query: [{ key: 'status', value: 'queued', operator: '$eq' }]
                    }
                }).then((data) => {
                    if (data) {
                        console.log('messageQueue', data.object)
                        for (let i = 0; i < data.object.length; i++) {
                            if (config.previousUrl)
                                data.object[i].previousUrl = config.previousUrl
                            this.send(data.object[i])
                        }
                    }
                })
            } else {
                // TODO: set and get messageQueue per socket.url 
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
                        token = configHandler.get("token");

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
                            configHandler.set('localSocketMessage', JSON.stringify(data))
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
                            array: socket.url,
                            object: { _id: uid, ...data }
                        })
                    }
                }
            });
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
            let url = socket.url

            setTimeout(() => {
                if (!self.maxReconnectDelay || self.currentReconnectDelay < self.maxReconnectDelay) {
                    if (config.balancer !== 'mesh') {
                        config.previousUrl = url
                        self.delete(url)
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
        CoCreateSocketClient.init()

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
