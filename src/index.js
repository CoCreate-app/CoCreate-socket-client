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
        define(["@cocreate/uuid", "@cocreate/indexeddb", "@cocreate/config"], function (uuid, indexeddb, config) {
            return factory(true, WebSocket, uuid, indexeddb = indexeddb.default, config = config.default)
        });
    } else if (typeof module === 'object' && module.exports) {
        const WebSocket = require("ws")
        const uuid = require("@cocreate/uuid");
        module.exports = factory(false, WebSocket, uuid);
    } else {
        // Browser globals (root is window)
        root.returnExports = factory(true, WebSocket, root["@cocreate/uuid"], root["@cocreate/indexeddb"], root["@cocreate/config"]);
    }
}(typeof self !== 'undefined' ? self : this, function (isBrowser, WebSocket, uuid, indexeddb, config) {
    const socketsByUrl = new Map()
    const socketsById = new Map()
    const delay = 1000 + Math.floor(Math.random() * 3000)

    let organizationPromise = null;
    async function getOrganization() {
        let organization_id = config.get('organization_id')
        if (!organization_id) {
            const Organization = await import('@cocreate/organizations')
            organization_id = await Organization.default.get()

        }
        if (organization_id)
            config.set('organization_id', organization_id)

        return organization_id
    }

    const CoCreateSocketClient = {
        connected: false,
        listeners: new Map(),
        messageQueue: new Map(), // required per url already per url when isBrowser and indexeddb.
        configQueue: new Map(),
        maxReconnectDelay: 600000,
        organization: false, // required per url
        serverDB: true, // required per url
        serverOrganization: true, // required per url
        organization_id: async () => {
            return organizationPromise || (organizationPromise = getOrganization());
        },

        //TODO: on app start up we can get the port and ip and public dns. Using config we can define if this app is behind an lb.
        // If behind an lb it can create a socket connection to the lb node in order to add node to the lb backend list.

        async init() {
            const defaults = { clientId: indexeddb.ObjectId(), host: window.location.host }
            const keys = ['clientId', 'apikey', 'host', 'user_id', 'balancer']
            for (let i = 0; i < keys.length; i++) {
                this[keys[i]] = config.get(keys[i]) || defaults[keys[i]] || ''
                config.set(keys[i], this[keys[i]])
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
        async create(data = {}) {
            const self = this;
            const urls = await this.getUrls(data);
            for (let url of urls) {
                let socket = this.get(url);
                if (socket)
                    return;

                this.set({ url });

                try {

                    let token = null;
                    if (isBrowser) {
                        token = config.get("token");
                    }

                    const options = {
                        socketId: uuid.generate(8),
                        clientId: this.clientId,
                        token: token || '',
                    }

                    if (isBrowser) {
                        options.lastSynced = config.get(url)

                    }

                    let opt = JSON.stringify(options)
                    opt = encodeURIComponent(opt)

                    socket = new WebSocket(url, opt)
                    socket.id = options.socketId;
                    socket.connected = false;
                    socket.clientId = this.clientId;
                    socket.organization_id = data.organization_id || await this.organization_id();
                    socket.user_id = data.user_id || this.user_id;
                    socket.host = data.host || this.host;
                    socket.key = url;

                    this.set(socket);
                } catch (error) {
                    console.log(error);
                    return;
                }

                socket.onopen = function (event) {
                    self.connected = true
                    socket.connected = true;
                    delete data.currentReconnectDelay
                    self.checkMessageQueue(data);
                };

                socket.onclose = function (event) {
                    socket.connected = false;
                    switch (event.code) {
                        case 1000: // close normal
                            console.log("websocket: closed");
                            break;
                        default:
                            self.reconnect(data, socket);
                            break;
                    }
                };

                socket.onerror = function (event) {
                    if (!isBrowser)
                        console.log(event.error);
                    else if (!window.navigator.onLine)
                        console.log("offline");

                    self.reconnect(data, socket);
                };

                socket.onmessage = function (message) {
                    try {
                        message = JSON.parse(message.data);
                        if (message.method === 'Access Denied' && message.permission) {
                            if (message.permission.storage === false)
                                self.serverDB = false
                            if (message.permission.organization === false)
                                self.serverOrganization = false
                            console.log(message.permission.error)
                        }

                        if (message.method != 'connect' && typeof message == 'object') {
                            if (isBrowser && message._id) {
                                let lastSynced = config.get(socket.url)

                                if (!lastSynced) {
                                    config.set(socket.url, message._id)
                                } else if (lastSynced !== message._id) {
                                    if (self.getDateFromObjectId(lastSynced) < self.getDateFromObjectId(message._id)) {
                                        config.set(socket.url, message._id)
                                    }
                                }

                                // here we can handle crud types inorder to avoid conflicts simply by deleting queued items prior to sending
                                let Data = {
                                    method: 'delete.object',
                                    array: 'message_log',
                                    $filter: {
                                        query: [
                                            { key: 'modified.on', value: message.timestamp, operator: '$gt' },
                                            { key: 'status', value: 'queued', operator: '$eq' }
                                        ]
                                    }
                                }

                                // TODO: we need to delete the item based on some conditions
                                // what are the conditions?
                                let type = message.method.split('.').pop()
                                for (let item of message[type]) {
                                    if (type == 'object') {
                                        Data.$filter.query.push({ key: 'data._id', value: item._id, operator: '$eq' })
                                    } else if (['database', 'array', 'index',].includes(type)) {
                                        Data.$filter.query.push({ key: 'data.name', value: item.name, operator: '$eq' })
                                    }
                                }
                                // indexeddb.send(Data)
                            }
                        }

                        if (message.broadcastClient && message.broadcastBrowser !== false && isBrowser && message.broadcastBrowser && !message.method.startsWith('read'))
                            config.set('localSocketMessage', JSON.stringify(message))

                        message.status = "received"

                        if (message && message.uid) {
                            self.__fireEvent(message.uid, message);
                        }

                        self.__fireListeners(message.method, message)
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

        // TODO: could be rquired in the serverside when handeling server to server mesh socket using crud-server instead
        checkMessageQueue(config) {
            if (isBrowser && indexeddb) {
                indexeddb.send({
                    method: 'delete.object',
                    array: 'message_log',
                    $filter: {
                        query: [
                            { key: 'status', value: 'queued', operator: '$eq' }
                        ]
                    },
                    organization_id: config.organization_id

                }).then((data) => {
                    if (data) {
                        for (let i = 0; i < data.object.length; i++) {
                            this.send(data.object[i].data)
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
            return new Promise(async (resolve, reject) => {
                data.clientId = this.clientId;

                if (!data['timeStamp'])
                    data['timeStamp'] = new Date();

                if (!data['organization_id'])
                    data['organization_id'] = await this.organization_id();

                if (!data['apikey'] && this.apikey)
                    data['apikey'] = this.apikey;

                if (!data['user_id'] && this.user_id)
                    data['user_id'] = this.user_id;

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
                const sockets = await this.getSockets(data);

                for (let socket of sockets) {
                    data.socketId = socket.id;

                    if (data.status === "resolved")
                        resolve();
                    else if (data.status !== "queued") {
                        if (isBrowser) {
                            window.addEventListener(uid, function (event) {
                                // here we have access to request and new data
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
                        token = config.get("token");

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

                    if (isBrowser) {
                        if (data.broadcastSender)
                            this.sendLocalMessage(data)
                        if (broadcastBrowser)
                            config.set('localSocketMessage', JSON.stringify(data))
                    }

                    if (isBrowser && indexeddb && data.status == "queued") {
                        indexeddb.send({
                            method: 'create.object',
                            array: 'message_log',
                            object: { _id: uid, data, status: 'queued' },
                            organization_id: data.organization_id
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
            if (!config.currentReconnectDelay)
                config.currentReconnectDelay = delay

            let url = socket.url
            if (isBrowser && !window.navigator.onLine) {
                const online = () => {
                    window.removeEventListener("online", online)
                    self.delete(url)
                    self.create(config);
                }
                window.addEventListener("online", online);
            } else {
                setTimeout(() => {
                    if (!self.maxReconnectDelay || config.currentReconnectDelay < self.maxReconnectDelay) {
                        self.delete(url)
                        config.currentReconnectDelay *= 2;
                        self.create(config);
                    }
                }, config.currentReconnectDelay);
            }
        },

        async getUrls(data = {}) {
            let protocol = 'wss';
            if (isBrowser && location.protocol !== "https:")
                protocol = "ws";

            let url, urls = [], hostUrls = [];
            let host = data.host || this.host
            let balancer = data.balancer || this.balancer
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

                    url += `/${data.organization_id || await this.organization_id() || ''}`
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
                url += `/${data.organization_id || await this.organization_id() || ''}`
                urls.push(url)
            } else {
                console.log('missing host')
            }

            return urls;
        },

        async getSockets(data) {
            let sockets = [];
            let urls = await this.getUrls(data)
            for (let url of urls) {
                let socket = this.get(url)
                if (!socket) {
                    await this.create(data)
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
        },

        // TODO: add to ObjectId function
        getDateFromObjectId(objectIdStr) {
            if (objectIdStr.length !== 24) {
                throw new Error('Invalid ObjectId string');
            }

            const timestampHex = objectIdStr.substring(0, 8);
            const timestampInt = parseInt(timestampHex, 16) * 1000; // Multiply by 1000 to get milliseconds
            return new Date(timestampInt);
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
