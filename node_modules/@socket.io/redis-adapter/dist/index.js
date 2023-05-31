"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisAdapter = exports.createAdapter = void 0;
const uid2 = require("uid2");
const msgpack = require("notepack.io");
const socket_io_adapter_1 = require("socket.io-adapter");
const debug = require("debug")("socket.io-redis");
module.exports = exports = createAdapter;
/**
 * Request types, for messages between nodes
 */
var RequestType;
(function (RequestType) {
    RequestType[RequestType["SOCKETS"] = 0] = "SOCKETS";
    RequestType[RequestType["ALL_ROOMS"] = 1] = "ALL_ROOMS";
    RequestType[RequestType["REMOTE_JOIN"] = 2] = "REMOTE_JOIN";
    RequestType[RequestType["REMOTE_LEAVE"] = 3] = "REMOTE_LEAVE";
    RequestType[RequestType["REMOTE_DISCONNECT"] = 4] = "REMOTE_DISCONNECT";
    RequestType[RequestType["REMOTE_FETCH"] = 5] = "REMOTE_FETCH";
    RequestType[RequestType["SERVER_SIDE_EMIT"] = 6] = "SERVER_SIDE_EMIT";
    RequestType[RequestType["BROADCAST"] = 7] = "BROADCAST";
    RequestType[RequestType["BROADCAST_CLIENT_COUNT"] = 8] = "BROADCAST_CLIENT_COUNT";
    RequestType[RequestType["BROADCAST_ACK"] = 9] = "BROADCAST_ACK";
})(RequestType || (RequestType = {}));
const isNumeric = (str) => !isNaN(str) && !isNaN(parseFloat(str));
/**
 * Returns a function that will create a RedisAdapter instance.
 *
 * @param pubClient - a Redis client that will be used to publish messages
 * @param subClient - a Redis client that will be used to receive messages (put in subscribed state)
 * @param opts - additional options
 *
 * @public
 */
function createAdapter(pubClient, subClient, opts) {
    return function (nsp) {
        return new RedisAdapter(nsp, pubClient, subClient, opts);
    };
}
exports.createAdapter = createAdapter;
class RedisAdapter extends socket_io_adapter_1.Adapter {
    /**
     * Adapter constructor.
     *
     * @param nsp - the namespace
     * @param pubClient - a Redis client that will be used to publish messages
     * @param subClient - a Redis client that will be used to receive messages (put in subscribed state)
     * @param opts - additional options
     *
     * @public
     */
    constructor(nsp, pubClient, subClient, opts = {}) {
        super(nsp);
        this.pubClient = pubClient;
        this.subClient = subClient;
        this.requests = new Map();
        this.ackRequests = new Map();
        this.uid = uid2(6);
        this.requestsTimeout = opts.requestsTimeout || 5000;
        this.publishOnSpecificResponseChannel = !!opts.publishOnSpecificResponseChannel;
        const prefix = opts.key || "socket.io";
        this.channel = prefix + "#" + nsp.name + "#";
        this.requestChannel = prefix + "-request#" + this.nsp.name + "#";
        this.responseChannel = prefix + "-response#" + this.nsp.name + "#";
        const specificResponseChannel = this.responseChannel + this.uid + "#";
        const isRedisV4 = typeof this.pubClient.pSubscribe === "function";
        if (isRedisV4) {
            this.subClient.pSubscribe(this.channel + "*", (msg, channel) => {
                this.onmessage(null, channel, msg);
            }, true);
            this.subClient.subscribe([this.requestChannel, this.responseChannel, specificResponseChannel], (msg, channel) => {
                this.onrequest(channel, msg);
            }, true);
        }
        else {
            this.subClient.psubscribe(this.channel + "*");
            this.subClient.on("pmessageBuffer", this.onmessage.bind(this));
            this.subClient.subscribe([
                this.requestChannel,
                this.responseChannel,
                specificResponseChannel,
            ]);
            this.subClient.on("messageBuffer", this.onrequest.bind(this));
        }
        const registerFriendlyErrorHandler = (redisClient) => {
            redisClient.on("error", () => {
                if (redisClient.listenerCount("error") === 1) {
                    console.warn("missing 'error' handler on this Redis client");
                }
            });
        };
        registerFriendlyErrorHandler(this.pubClient);
        registerFriendlyErrorHandler(this.subClient);
    }
    /**
     * Called with a subscription message
     *
     * @private
     */
    onmessage(pattern, channel, msg) {
        channel = channel.toString();
        const channelMatches = channel.startsWith(this.channel);
        if (!channelMatches) {
            return debug("ignore different channel");
        }
        const room = channel.slice(this.channel.length, -1);
        if (room !== "" && !this.hasRoom(room)) {
            return debug("ignore unknown room %s", room);
        }
        const args = msgpack.decode(msg);
        const [uid, packet, opts] = args;
        if (this.uid === uid)
            return debug("ignore same uid");
        if (packet && packet.nsp === undefined) {
            packet.nsp = "/";
        }
        if (!packet || packet.nsp !== this.nsp.name) {
            return debug("ignore different namespace");
        }
        opts.rooms = new Set(opts.rooms);
        opts.except = new Set(opts.except);
        super.broadcast(packet, opts);
    }
    hasRoom(room) {
        // @ts-ignore
        const hasNumericRoom = isNumeric(room) && this.rooms.has(parseFloat(room));
        return hasNumericRoom || this.rooms.has(room);
    }
    /**
     * Called on request from another node
     *
     * @private
     */
    async onrequest(channel, msg) {
        channel = channel.toString();
        if (channel.startsWith(this.responseChannel)) {
            return this.onresponse(channel, msg);
        }
        else if (!channel.startsWith(this.requestChannel)) {
            return debug("ignore different channel");
        }
        let request;
        try {
            // if the buffer starts with a "{" character
            if (msg[0] === 0x7b) {
                request = JSON.parse(msg.toString());
            }
            else {
                request = msgpack.decode(msg);
            }
        }
        catch (err) {
            debug("ignoring malformed request");
            return;
        }
        debug("received request %j", request);
        let response, socket;
        switch (request.type) {
            case RequestType.SOCKETS:
                if (this.requests.has(request.requestId)) {
                    return;
                }
                const sockets = await super.sockets(new Set(request.rooms));
                response = JSON.stringify({
                    requestId: request.requestId,
                    sockets: [...sockets],
                });
                this.publishResponse(request, response);
                break;
            case RequestType.ALL_ROOMS:
                if (this.requests.has(request.requestId)) {
                    return;
                }
                response = JSON.stringify({
                    requestId: request.requestId,
                    rooms: [...this.rooms.keys()],
                });
                this.publishResponse(request, response);
                break;
            case RequestType.REMOTE_JOIN:
                if (request.opts) {
                    const opts = {
                        rooms: new Set(request.opts.rooms),
                        except: new Set(request.opts.except),
                    };
                    return super.addSockets(opts, request.rooms);
                }
                socket = this.nsp.sockets.get(request.sid);
                if (!socket) {
                    return;
                }
                socket.join(request.room);
                response = JSON.stringify({
                    requestId: request.requestId,
                });
                this.publishResponse(request, response);
                break;
            case RequestType.REMOTE_LEAVE:
                if (request.opts) {
                    const opts = {
                        rooms: new Set(request.opts.rooms),
                        except: new Set(request.opts.except),
                    };
                    return super.delSockets(opts, request.rooms);
                }
                socket = this.nsp.sockets.get(request.sid);
                if (!socket) {
                    return;
                }
                socket.leave(request.room);
                response = JSON.stringify({
                    requestId: request.requestId,
                });
                this.publishResponse(request, response);
                break;
            case RequestType.REMOTE_DISCONNECT:
                if (request.opts) {
                    const opts = {
                        rooms: new Set(request.opts.rooms),
                        except: new Set(request.opts.except),
                    };
                    return super.disconnectSockets(opts, request.close);
                }
                socket = this.nsp.sockets.get(request.sid);
                if (!socket) {
                    return;
                }
                socket.disconnect(request.close);
                response = JSON.stringify({
                    requestId: request.requestId,
                });
                this.publishResponse(request, response);
                break;
            case RequestType.REMOTE_FETCH:
                if (this.requests.has(request.requestId)) {
                    return;
                }
                const opts = {
                    rooms: new Set(request.opts.rooms),
                    except: new Set(request.opts.except),
                };
                const localSockets = await super.fetchSockets(opts);
                response = JSON.stringify({
                    requestId: request.requestId,
                    sockets: localSockets.map((socket) => {
                        // remove sessionStore from handshake, as it may contain circular references
                        const _a = socket.handshake, { sessionStore } = _a, handshake = __rest(_a, ["sessionStore"]);
                        return {
                            id: socket.id,
                            handshake,
                            rooms: [...socket.rooms],
                            data: socket.data,
                        };
                    }),
                });
                this.publishResponse(request, response);
                break;
            case RequestType.SERVER_SIDE_EMIT:
                if (request.uid === this.uid) {
                    debug("ignore same uid");
                    return;
                }
                const withAck = request.requestId !== undefined;
                if (!withAck) {
                    this.nsp._onServerSideEmit(request.data);
                    return;
                }
                let called = false;
                const callback = (arg) => {
                    // only one argument is expected
                    if (called) {
                        return;
                    }
                    called = true;
                    debug("calling acknowledgement with %j", arg);
                    this.pubClient.publish(this.responseChannel, JSON.stringify({
                        type: RequestType.SERVER_SIDE_EMIT,
                        requestId: request.requestId,
                        data: arg,
                    }));
                };
                request.data.push(callback);
                this.nsp._onServerSideEmit(request.data);
                break;
            case RequestType.BROADCAST: {
                if (this.ackRequests.has(request.requestId)) {
                    // ignore self
                    return;
                }
                const opts = {
                    rooms: new Set(request.opts.rooms),
                    except: new Set(request.opts.except),
                };
                super.broadcastWithAck(request.packet, opts, (clientCount) => {
                    debug("waiting for %d client acknowledgements", clientCount);
                    this.publishResponse(request, JSON.stringify({
                        type: RequestType.BROADCAST_CLIENT_COUNT,
                        requestId: request.requestId,
                        clientCount,
                    }));
                }, (arg) => {
                    debug("received acknowledgement with value %j", arg);
                    this.publishResponse(request, msgpack.encode({
                        type: RequestType.BROADCAST_ACK,
                        requestId: request.requestId,
                        packet: arg,
                    }));
                });
                break;
            }
            default:
                debug("ignoring unknown request type: %s", request.type);
        }
    }
    /**
     * Send the response to the requesting node
     * @param request
     * @param response
     * @private
     */
    publishResponse(request, response) {
        const responseChannel = this.publishOnSpecificResponseChannel
            ? `${this.responseChannel}${request.uid}#`
            : this.responseChannel;
        debug("publishing response to channel %s", responseChannel);
        this.pubClient.publish(responseChannel, response);
    }
    /**
     * Called on response from another node
     *
     * @private
     */
    onresponse(channel, msg) {
        let response;
        try {
            // if the buffer starts with a "{" character
            if (msg[0] === 0x7b) {
                response = JSON.parse(msg.toString());
            }
            else {
                response = msgpack.decode(msg);
            }
        }
        catch (err) {
            debug("ignoring malformed response");
            return;
        }
        const requestId = response.requestId;
        if (this.ackRequests.has(requestId)) {
            const ackRequest = this.ackRequests.get(requestId);
            switch (response.type) {
                case RequestType.BROADCAST_CLIENT_COUNT: {
                    ackRequest === null || ackRequest === void 0 ? void 0 : ackRequest.clientCountCallback(response.clientCount);
                    break;
                }
                case RequestType.BROADCAST_ACK: {
                    ackRequest === null || ackRequest === void 0 ? void 0 : ackRequest.ack(response.packet);
                    break;
                }
            }
            return;
        }
        if (!requestId ||
            !(this.requests.has(requestId) || this.ackRequests.has(requestId))) {
            debug("ignoring unknown request");
            return;
        }
        debug("received response %j", response);
        const request = this.requests.get(requestId);
        switch (request.type) {
            case RequestType.SOCKETS:
            case RequestType.REMOTE_FETCH:
                request.msgCount++;
                // ignore if response does not contain 'sockets' key
                if (!response.sockets || !Array.isArray(response.sockets))
                    return;
                if (request.type === RequestType.SOCKETS) {
                    response.sockets.forEach((s) => request.sockets.add(s));
                }
                else {
                    response.sockets.forEach((s) => request.sockets.push(s));
                }
                if (request.msgCount === request.numSub) {
                    clearTimeout(request.timeout);
                    if (request.resolve) {
                        request.resolve(request.sockets);
                    }
                    this.requests.delete(requestId);
                }
                break;
            case RequestType.ALL_ROOMS:
                request.msgCount++;
                // ignore if response does not contain 'rooms' key
                if (!response.rooms || !Array.isArray(response.rooms))
                    return;
                response.rooms.forEach((s) => request.rooms.add(s));
                if (request.msgCount === request.numSub) {
                    clearTimeout(request.timeout);
                    if (request.resolve) {
                        request.resolve(request.rooms);
                    }
                    this.requests.delete(requestId);
                }
                break;
            case RequestType.REMOTE_JOIN:
            case RequestType.REMOTE_LEAVE:
            case RequestType.REMOTE_DISCONNECT:
                clearTimeout(request.timeout);
                if (request.resolve) {
                    request.resolve();
                }
                this.requests.delete(requestId);
                break;
            case RequestType.SERVER_SIDE_EMIT:
                request.responses.push(response.data);
                debug("serverSideEmit: got %d responses out of %d", request.responses.length, request.numSub);
                if (request.responses.length === request.numSub) {
                    clearTimeout(request.timeout);
                    if (request.resolve) {
                        request.resolve(null, request.responses);
                    }
                    this.requests.delete(requestId);
                }
                break;
            default:
                debug("ignoring unknown request type: %s", request.type);
        }
    }
    /**
     * Broadcasts a packet.
     *
     * @param {Object} packet - packet to emit
     * @param {Object} opts - options
     *
     * @public
     */
    broadcast(packet, opts) {
        packet.nsp = this.nsp.name;
        const onlyLocal = opts && opts.flags && opts.flags.local;
        if (!onlyLocal) {
            const rawOpts = {
                rooms: [...opts.rooms],
                except: [...new Set(opts.except)],
                flags: opts.flags,
            };
            const msg = msgpack.encode([this.uid, packet, rawOpts]);
            let channel = this.channel;
            if (opts.rooms && opts.rooms.size === 1) {
                channel += opts.rooms.keys().next().value + "#";
            }
            debug("publishing message to channel %s", channel);
            this.pubClient.publish(channel, msg);
        }
        super.broadcast(packet, opts);
    }
    broadcastWithAck(packet, opts, clientCountCallback, ack) {
        var _a;
        packet.nsp = this.nsp.name;
        const onlyLocal = (_a = opts === null || opts === void 0 ? void 0 : opts.flags) === null || _a === void 0 ? void 0 : _a.local;
        if (!onlyLocal) {
            const requestId = uid2(6);
            const rawOpts = {
                rooms: [...opts.rooms],
                except: [...new Set(opts.except)],
                flags: opts.flags,
            };
            const request = msgpack.encode({
                uid: this.uid,
                requestId,
                type: RequestType.BROADCAST,
                packet,
                opts: rawOpts,
            });
            this.pubClient.publish(this.requestChannel, request);
            this.ackRequests.set(requestId, {
                clientCountCallback,
                ack,
            });
            // we have no way to know at this level whether the server has received an acknowledgement from each client, so we
            // will simply clean up the ackRequests map after the given delay
            setTimeout(() => {
                this.ackRequests.delete(requestId);
            }, opts.flags.timeout);
        }
        super.broadcastWithAck(packet, opts, clientCountCallback, ack);
    }
    /**
     * @deprecated Please use `namespace.fetchSockets()` instead.
     *
     * Gets a list of sockets by sid.
     *
     * @param {Set<Room>} rooms   the explicit set of rooms to check.
     */
    async sockets(rooms) {
        const localSockets = await super.sockets(rooms);
        const numSub = await this.getNumSub();
        debug('waiting for %d responses to "sockets" request', numSub);
        if (numSub <= 1) {
            return Promise.resolve(localSockets);
        }
        const requestId = uid2(6);
        const request = JSON.stringify({
            uid: this.uid,
            requestId,
            type: RequestType.SOCKETS,
            rooms: [...rooms],
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for sockets response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.SOCKETS,
                numSub,
                resolve,
                timeout,
                msgCount: 1,
                sockets: localSockets,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    /**
     * Gets the list of all rooms (across every node)
     *
     * @public
     */
    async allRooms() {
        const localRooms = new Set(this.rooms.keys());
        const numSub = await this.getNumSub();
        debug('waiting for %d responses to "allRooms" request', numSub);
        if (numSub <= 1) {
            return localRooms;
        }
        const requestId = uid2(6);
        const request = JSON.stringify({
            uid: this.uid,
            requestId,
            type: RequestType.ALL_ROOMS,
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for allRooms response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.ALL_ROOMS,
                numSub,
                resolve,
                timeout,
                msgCount: 1,
                rooms: localRooms,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    /**
     * @deprecated Please use `namespace.socketsJoin()` instead.
     *
     * Makes the socket with the given id join the room
     *
     * @param {String} id - socket id
     * @param {String} room - room name
     * @public
     */
    remoteJoin(id, room) {
        const requestId = uid2(6);
        const socket = this.nsp.sockets.get(id);
        if (socket) {
            socket.join(room);
            return Promise.resolve();
        }
        const request = JSON.stringify({
            uid: this.uid,
            requestId,
            type: RequestType.REMOTE_JOIN,
            sid: id,
            room,
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for remoteJoin response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.REMOTE_JOIN,
                resolve,
                timeout,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    /**
     * @deprecated Please use `namespace.socketsLeave()` instead.
     *
     * Makes the socket with the given id leave the room
     *
     * @param {String} id - socket id
     * @param {String} room - room name
     * @public
     */
    remoteLeave(id, room) {
        const requestId = uid2(6);
        const socket = this.nsp.sockets.get(id);
        if (socket) {
            socket.leave(room);
            return Promise.resolve();
        }
        const request = JSON.stringify({
            uid: this.uid,
            requestId,
            type: RequestType.REMOTE_LEAVE,
            sid: id,
            room,
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for remoteLeave response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.REMOTE_LEAVE,
                resolve,
                timeout,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    /**
     * @deprecated Please use `namespace.disconnectSockets()` instead.
     *
     * Makes the socket with the given id to be forcefully disconnected
     *
     * @param {String} id - socket id
     * @param {Boolean} close - if `true`, closes the underlying connection
     *
     * @public
     */
    remoteDisconnect(id, close) {
        const requestId = uid2(6);
        const socket = this.nsp.sockets.get(id);
        if (socket) {
            socket.disconnect(close);
            return Promise.resolve();
        }
        const request = JSON.stringify({
            uid: this.uid,
            requestId,
            type: RequestType.REMOTE_DISCONNECT,
            sid: id,
            close,
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for remoteDisconnect response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.REMOTE_DISCONNECT,
                resolve,
                timeout,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    async fetchSockets(opts) {
        var _a;
        const localSockets = await super.fetchSockets(opts);
        if ((_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local) {
            return localSockets;
        }
        const numSub = await this.getNumSub();
        debug('waiting for %d responses to "fetchSockets" request', numSub);
        if (numSub <= 1) {
            return localSockets;
        }
        const requestId = uid2(6);
        const request = JSON.stringify({
            uid: this.uid,
            requestId,
            type: RequestType.REMOTE_FETCH,
            opts: {
                rooms: [...opts.rooms],
                except: [...opts.except],
            },
        });
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this.requests.has(requestId)) {
                    reject(new Error("timeout reached while waiting for fetchSockets response"));
                    this.requests.delete(requestId);
                }
            }, this.requestsTimeout);
            this.requests.set(requestId, {
                type: RequestType.REMOTE_FETCH,
                numSub,
                resolve,
                timeout,
                msgCount: 1,
                sockets: localSockets,
            });
            this.pubClient.publish(this.requestChannel, request);
        });
    }
    addSockets(opts, rooms) {
        var _a;
        if ((_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local) {
            return super.addSockets(opts, rooms);
        }
        const request = JSON.stringify({
            uid: this.uid,
            type: RequestType.REMOTE_JOIN,
            opts: {
                rooms: [...opts.rooms],
                except: [...opts.except],
            },
            rooms: [...rooms],
        });
        this.pubClient.publish(this.requestChannel, request);
    }
    delSockets(opts, rooms) {
        var _a;
        if ((_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local) {
            return super.delSockets(opts, rooms);
        }
        const request = JSON.stringify({
            uid: this.uid,
            type: RequestType.REMOTE_LEAVE,
            opts: {
                rooms: [...opts.rooms],
                except: [...opts.except],
            },
            rooms: [...rooms],
        });
        this.pubClient.publish(this.requestChannel, request);
    }
    disconnectSockets(opts, close) {
        var _a;
        if ((_a = opts.flags) === null || _a === void 0 ? void 0 : _a.local) {
            return super.disconnectSockets(opts, close);
        }
        const request = JSON.stringify({
            uid: this.uid,
            type: RequestType.REMOTE_DISCONNECT,
            opts: {
                rooms: [...opts.rooms],
                except: [...opts.except],
            },
            close,
        });
        this.pubClient.publish(this.requestChannel, request);
    }
    serverSideEmit(packet) {
        const withAck = typeof packet[packet.length - 1] === "function";
        if (withAck) {
            this.serverSideEmitWithAck(packet).catch(() => {
                // ignore errors
            });
            return;
        }
        const request = JSON.stringify({
            uid: this.uid,
            type: RequestType.SERVER_SIDE_EMIT,
            data: packet,
        });
        this.pubClient.publish(this.requestChannel, request);
    }
    async serverSideEmitWithAck(packet) {
        const ack = packet.pop();
        const numSub = (await this.getNumSub()) - 1; // ignore self
        debug('waiting for %d responses to "serverSideEmit" request', numSub);
        if (numSub <= 0) {
            return ack(null, []);
        }
        const requestId = uid2(6);
        const request = JSON.stringify({
            uid: this.uid,
            requestId,
            type: RequestType.SERVER_SIDE_EMIT,
            data: packet,
        });
        const timeout = setTimeout(() => {
            const storedRequest = this.requests.get(requestId);
            if (storedRequest) {
                ack(new Error(`timeout reached: only ${storedRequest.responses.length} responses received out of ${storedRequest.numSub}`), storedRequest.responses);
                this.requests.delete(requestId);
            }
        }, this.requestsTimeout);
        this.requests.set(requestId, {
            type: RequestType.SERVER_SIDE_EMIT,
            numSub,
            timeout,
            resolve: ack,
            responses: [],
        });
        this.pubClient.publish(this.requestChannel, request);
    }
    /**
     * Get the number of subscribers of the request channel
     *
     * @private
     */
    getNumSub() {
        if (this.pubClient.constructor.name === "Cluster" ||
            this.pubClient.isCluster) {
            // Cluster
            const nodes = this.pubClient.nodes();
            return Promise.all(nodes.map((node) => node.send_command("pubsub", ["numsub", this.requestChannel]))).then((values) => {
                let numSub = 0;
                values.map((value) => {
                    numSub += parseInt(value[1], 10);
                });
                return numSub;
            });
        }
        else if (typeof this.pubClient.pSubscribe === "function") {
            return this.pubClient
                .sendCommand(["pubsub", "numsub", this.requestChannel])
                .then((res) => parseInt(res[1], 10));
        }
        else {
            // RedisClient or Redis
            return new Promise((resolve, reject) => {
                this.pubClient.send_command("pubsub", ["numsub", this.requestChannel], (err, numSub) => {
                    if (err)
                        return reject(err);
                    resolve(parseInt(numSub[1], 10));
                });
            });
        }
    }
    serverCount() {
        return this.getNumSub();
    }
}
exports.RedisAdapter = RedisAdapter;
