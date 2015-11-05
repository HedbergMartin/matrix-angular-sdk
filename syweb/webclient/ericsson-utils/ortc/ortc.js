(function (global) {

    var signalingStateMap = {
        "stable": {
            "setLocal:offer": "have-local-offer",
            "setRemote:offer": "have-remote-offer"
        },
        "have-local-offer": {
            "setLocal:offer": "have-local-offer",
            "setRemote:answer": "stable"
        },
        "have-remote-offer": {
            "setLocal:answer": "stable",
            "setRemote:offer": "have-remote-offer"
        }
    };

    //
    // RTCPeerConnection
    //
    RTCPeerConnection.prototype = Object.create(EventTarget.prototype);
    RTCPeerConnection.prototype.constructor = RTCPeerConnection;

    function RTCPeerConnection(configuration) {
        var _this = this;

         EventTarget.call(this, {
            "onnegotiationneeded": null,
            "onicecandidate": null,
            "onsignalingstatechange": null,
            "onaddstream": null,
            "onremovestream": null,
            "oniceconnectionstatechange": null,
            "ondatachannel": null
        });

        var a = { // attributes
            "localDescription": getLocalDescription,
            "remoteDescription": getRemoteDescription,
            "signalingState": "stable",
            "iceGatheringState": "new",
            "iceConnectionState": "new"
        };
        domObject.addReadOnlyAttributes(this, a);

        checkArguments("RTCPeerConnection", "dictionary", 1, arguments);
        checkConfigurationDictionary(configuration);

        if (!configuration.iceTransports)
            configuration.iceTransports = "all"

        var localStreams = [];
        var remoteStreams = [];

        var cname = randomString(16);
        var negotiationNeededTimerHandle;
        var hasDataChannels = false;
        var localSessionInfo = null;
        var remoteSessionInfo = null;
        var remoteSourceStatus = [];
        var lastSetLocalDescriptionType;
        var lastSetRemoteDescriptionType;
        var queuedOperations = [];
        var stateChangingOperationsQueued = false;

        var mediaTransports = [];

        function enqueueOperation(operation, isStateChanger) {
            queuedOperations.push(operation);
            stateChangingOperationsQueued = !!isStateChanger;
            if (queuedOperations.length == 1)
                setTimeout(queuedOperations[0]);
        }

        function completeQueuedOperation(callback) {
            queuedOperations.shift();
            if (queuedOperations.length)
                setTimeout(queuedOperations[0]);

            try {
                callback();
            } catch (e) {
                setTimeout(function () {
                    throw e;
                });
            }

            if (!queuedOperations.length && stateChangingOperationsQueued) {
                maybeDispatchNegotiationNeeded();
                stateChangingOperationsQueued = false;
            }
        }

        function updateMediaDescriptionsWithTracks(mediaDescriptions, trackInfos) {
            mediaDescriptions.forEach(function (mdesc) {
                var index = indexOfByProperty(trackInfos, "mediaStreamTrackId",
                    mdesc.mediaStreamTrackId);
                if (index != -1)
                    trackInfos.splice(index, 1);
                else {
                    mdesc.mediaStreamId = null;
                    mdesc.mediaStreamTrackId = null;
                }
            });

            mediaDescriptions.forEach(function (mdesc) {
                if (mdesc.mediaStreamTrackId)
                    return;

                var index = indexOfByProperty(trackInfos, "kind", mdesc.type);
                if (index != -1) {
                    mdesc.mediaStreamId = trackInfos[index].mediaStreamId;
                    mdesc.mediaStreamTrackId = trackInfos[index].mediaStreamTrackId;
                    mdesc.mode = "sendrecv";
                    trackInfos.splice(index, 1);
                } else
                    mdesc.mode = "recvonly";
            });
        }

        this.createOffer = function () {
            // backwards compatibility with callback based method
            var callbackArgsError = getArgumentsError("function, function, dictionary", 2, arguments);
            if (!callbackArgsError) {
                internalCreateOffer(arguments[2]).then(arguments[0]).catch(arguments[1]);
                return;
            }

            var promiseArgsError = getArgumentsError("dictionary", 0, arguments);
            if (!promiseArgsError)
                return internalCreateOffer(arguments[0]);

            throwNoMatchingSignature("createOffer", promiseArgsError, callbackArgsError);
        };

        function internalCreateOffer(options) {
            if (options) {
                checkDictionary("RTCOfferOptions", options, {
                    "offerToReceiveVideo": "number | boolean",
                    "offerToReceiveAudio": "number | boolean"
                });
            }
            checkClosedState("createOffer");

            return new Promise(function (resolve, reject) {
                enqueueOperation(function () {
                    queuedCreateOffer(resolve, reject, options);
                });
            });
        }

        function queuedCreateOffer(resolve, reject, options) {
            options = options || {};
            options.offerToReceiveAudio = +options.offerToReceiveAudio || 0;
            options.offerToReceiveVideo = +options.offerToReceiveVideo || 0;

            var localSessionInfoSnapshot = localSessionInfo ?
                JSON.parse(JSON.stringify(localSessionInfo)) : { "mediaDescriptions": [] };

            var localTrackInfos = getTrackInfos(localStreams);
            updateMediaDescriptionsWithTracks(localSessionInfoSnapshot.mediaDescriptions,
                localTrackInfos);

            localTrackInfos.forEach(function (trackInfo) {
                var codecs = RTCRtpReceiver.getCapabilities(trackInfo.kind).codecs;
                var offerCodecs = createOfferCodecs(trackInfo.kind);

                localSessionInfoSnapshot.mediaDescriptions.push({
                    "mediaStreamId": trackInfo.mediaStreamId,
                    "mediaStreamTrackId": trackInfo.mediaStreamTrackId,
                    "type": trackInfo.kind,
                    "payloads": offerCodecs,
                    "rtcp": { "mux": true },
                    "ssrcs": [ randomNumber(32) ],
                    "cname": cname,
                    // "ice": { "ufrag": randomString(4), "password": randomString(22) },
                    "dtls": { "setup": "actpass" }
                });
            });

            [ "Audio", "Video" ].forEach(function (mediaType) {
                for (var i = 0; i < options["offerToReceive" + mediaType]; i++) {
                    var kind = mediaType.toLowerCase();
                    var offerCodecs = createOfferCodecs(kind);

                    localSessionInfoSnapshot.mediaDescriptions.push({
                        "type": kind,
                        "payloads": offerCodecs,
                        "rtcp": { "mux": true },
                        "dtls": { "setup": "actpass" },
                        "mode": "recvonly"
                    });
                }
            });

            // Skip RTCDataChannel support for now

            // if (hasDataChannels && indexOfByProperty(localSessionInfoSnapshot.mediaDescriptions,
            //     "type", "application") == -1) {
            //     localSessionInfoSnapshot.mediaDescriptions.push({
            //         "type": "application",
            //         "protocol": "DTLS/SCTP",
            //         "fmt": 5000,
            //         "ice": { "ufrag": randomString(4), "password": randomString(22) },
            //         "dtls": { "setup": "actpass" },
            //         "sctp": {
            //             "port": 5000,
            //             "app": "webrtc-datachannel",
            //             "streams": 1024
            //         }
            //     });
            // }

            completeQueuedOperation(function () {
                resolve(new RTCSessionDescription({
                    "type": "offer",
                    "sdp": SDP.generate(localSessionInfoSnapshot)
                }));
            });
        }

        function createOfferCodecs (kind) {
            var codecs = RTCRtpReceiver.getCapabilities(kind).codecs;

            var offerCodecs = [];
            codecs.forEach(function (codec) {
                var offerCodec = {
                    "encodingName": codec.name,
                    "type": codec.preferredPayloadType,
                    "clockRate": codec.clockRate
                };

                if (kind == "audio")
                    offerCodec.channels = codec.numChannels;

                offerCodecs.push(offerCodec);
            });
            return offerCodecs;
        }

        this.createAnswer = function () {
            // backwards compatibility with callback based method
            var callbackArgsError = getArgumentsError("function, function, dictionary", 2, arguments);
            if (!callbackArgsError) {
                internalCreateAnswer(arguments[2]).then(arguments[0]).catch(arguments[1]);
                return;
            }

            var promiseArgsError = getArgumentsError("dictionary", 0, arguments);
            if (!promiseArgsError)
                return internalCreateAnswer(arguments[0]);

            throwNoMatchingSignature("createAnswer", promiseArgsError, callbackArgsError);
        };

        function internalCreateAnswer(options) {
            if (options) {
                checkDictionary("RTCOfferOptions", options, {
                    "offerToReceiveVideo": "number | boolean",
                    "offerToReceiveAudio": "number | boolean"
                });
            }
            checkClosedState("createAnswer");

            return new Promise(function (resolve, reject) {
                enqueueOperation(function () {
                    queuedCreateAnswer(resolve, reject, options);
                });
            });
        }

        function queuedCreateAnswer(resolve, reject, options) {

            if (!remoteSessionInfo) {
                completeQueuedOperation(function () {
                    reject(createError("InvalidStateError",
                        "createAnswer: no remote description set"));
                });
                return;
            }

            var localSessionInfoSnapshot = localSessionInfo ?
                JSON.parse(JSON.stringify(localSessionInfo)) : { "mediaDescriptions": [] };

            for (var i = 0; i < remoteSessionInfo.mediaDescriptions.length; i++) {
                var lmdesc = localSessionInfoSnapshot.mediaDescriptions[i];
                var rmdesc = remoteSessionInfo.mediaDescriptions[i];
                if (!lmdesc) {
                    lmdesc = {
                        "type": rmdesc.type,
                        // "ice": { "ufrag": randomString(4), "password": randomString(22) },
                        "dtls": { "setup": rmdesc.dtls.setup == "active" ? "passive" : "active" }
                    };
                    localSessionInfoSnapshot.mediaDescriptions.push(lmdesc);
                }

                if (lmdesc.type == "application") {
                    lmdesc.protocol = "DTLS/SCTP";
                    lmdesc.sctp = {
                        "port": 5000,
                        "app": "webrtc-datachannel"
                    };
                    if (rmdesc.sctp) {
                        lmdesc.sctp.streams = rmdesc.sctp.streams;
                    }
                } else {
                    lmdesc.payloads = rmdesc.payloads;

                    if (!lmdesc.rtcp)
                        lmdesc.rtcp = {};

                    lmdesc.rtcp.mux = !!(rmdesc.rtcp && rmdesc.rtcp.mux);

                    do {
                        lmdesc.ssrcs = [ randomNumber(32) ];
                    } while (rmdesc.ssrcs && rmdesc.ssrcs.indexOf(lmdesc.ssrcs[0]) != -1);

                    lmdesc.cname = cname;
                }

                if (lmdesc.dtls.setup == "actpass")
                    lmdesc.dtls.setup = "passive";
            }

            var localTrackInfos = getTrackInfos(localStreams);
            updateMediaDescriptionsWithTracks(localSessionInfoSnapshot.mediaDescriptions,
                localTrackInfos);

            completeQueuedOperation(function () {
                resolve(new RTCSessionDescription({
                    "type": "answer",
                    "sdp": SDP.generate(localSessionInfoSnapshot)
                }));
            });
        }

        var latestLocalDescriptionCallback;

        this.setLocalDescription = function () {
            // backwards compatibility with callback based method
            var callbackArgsError = getArgumentsError("ortcRTCSessionDescription, function, function", 3, arguments);
            if (!callbackArgsError) {
                internalSetLocalDescription(arguments[0]).then(arguments[1]).catch(arguments[2]);
                return;
            }

            var promiseArgsError = getArgumentsError("ortcRTCSessionDescription", 1, arguments);
            if (!promiseArgsError)
                return internalSetLocalDescription(arguments[0]);

            throwNoMatchingSignature("setLocalDescription", promiseArgsError, callbackArgsError);
        };

        function internalSetLocalDescription(description) {
            checkClosedState("setLocalDescription");

            return new Promise(function (resolve, reject) {
                enqueueOperation(function () {
                    queuedSetLocalDescription(description, resolve, reject);
                }, true);
            });
        }

        function queuedSetLocalDescription(description, resolve, reject) {
            var targetState = signalingStateMap[a.signalingState]["setLocal:" + description.type];
            if (!targetState) {
                completeQueuedOperation(function () {
                    reject(createError("InvalidSessionDescriptionError",
                        "setLocalDescription: description type \"" +
                        entityReplace(description.type) + "\" invalid for the current state \"" +
                        a.signalingState + "\""));
                });
                return;
            }

            var previousNumberOfMediaDescriptions = localSessionInfo ?
                localSessionInfo.mediaDescriptions.length : 0;

            localSessionInfo = SDP.parse(description.sdp);
            lastSetLocalDescriptionType = description.type;

            var numberOfMediaDescriptions = localSessionInfo.mediaDescriptions.length;
            var isInitiator = description.type == "offer";

            for (var i = previousNumberOfMediaDescriptions; i < numberOfMediaDescriptions; i++) {
                var mdesc = localSessionInfo.mediaDescriptions[i];
                var transport = ensureMediaTransport(i, true, isInitiator);

                var iceGathererParams = transport.iceGatherer.getLocalParameters();
                var dtlsTransportParams = transport.dtlsTransport.getLocalParameters();

                mdesc.ice = {
                    "ufrag": iceGathererParams.usernameFragment,
                    "password": iceGathererParams.password
                };

                mdesc.dtls.fingerprintHashFunction = dtlsTransportParams.fingerprints[0].algorithm;
                mdesc.dtls.fingerprint = dtlsTransportParams.fingerprints[0].value;
            }

            tryToSendAndReceive();

            completeQueuedOperation(function () {
                a.signalingState = targetState;
                resolve();
            });
        }

        function ensureMediaTransport(mdescIndex, startGathering, isInitiator) {
            if (!mediaTransports[mdescIndex]) {
                var iceTransport = new RTCIceTransport();
                var dtlsTransport = new RTCDtlsTransport(iceTransport);

                mediaTransports[mdescIndex] = {
                    "transportsStarted": false,
                    "iceRole": isInitiator ? "controlling" : "controlled",
                    "iceTransport": iceTransport,
                    "dtlsTransport": dtlsTransport
                };

                iceTransport.onicestatechange = function () {
                    console.log("iceTransport.state: " + iceTransport.state);
                };
            }

            if (!mediaTransports[mdescIndex].iceGatherer && startGathering) {
                var iceGatherer = new RTCIceGatherer({ "gatherPolicy": "all", "iceServers": [] });
                prepareIceGatherer(iceGatherer, mdescIndex);
                mediaTransports[mdescIndex].iceGatherer = iceGatherer;
            }

            return mediaTransports[mdescIndex];
        }

        function prepareIceGatherer(iceGatherer, mdescIndex) {
            var mediaDescription = localSessionInfo.mediaDescriptions[mdescIndex];
            

            iceGatherer.onlocalcandidate = function (evt) {
                console.log("iceGatherer: got new local candidate");

                if (!evt.candidate.type) {
                    if (mdescIndex >= localSessionInfo.mediaDescriptions.length-1) {
                        _this.dispatchEvent({ "type": "icecandidate", "candidate": null,
                        "target": _this });
                    }
                    return;
                }

                var candidate = {
                    "type": evt.candidate.type,
                    "foundation": evt.candidate.foundation,
                    "componentId": 1, // FIXME
                    "transport": evt.candidate.protocol.toUpperCase(),
                    "priority": evt.candidate.priority,
                    "address": evt.candidate.ip,
                    "port": evt.candidate.port || 9,
                    "tcpType": evt.candidate.protocol == "tcp" ? evt.candidate.tcpType : null
                };

                if (candidate.type != "host") {
                    candidate.relatedAddress = evt.candidate.relatedAddress;
                    candidate.relatedPort = evt.candidate.relatedPort;
                }

                if (!mediaDescription.ice.candidates)
                    mediaDescription.ice.candidates = [];

                mediaDescription.ice.candidates.push(candidate);

                dispatchIceCandidate(candidate, mdescIndex);

                if (Object.keys(evt.candidate).length == 0) {
                    console.log("End of local candidates!");
                }
            };

            iceGatherer.ongathererstatechange = function () {
                console.log("iceGatherer.state: " + iceGatherer.state);
            };
        }

        function payloadsToCodecs(payloads) {
            return payloads.map(function (payload) {
                return {
                    "name": payload.encodingName,
                    "payloadType": payload.type,
                    "clockRate": payload.clockRate,
                    "numChannels": payload.channels || 1 //FIXME ORTC BUG
                };
            });
        }

        function createRtpParams(muxId, codecs, headerExtensions, encodings, rtcp) {
            return {
                "muxId": muxId,
                "codecs": codecs,
                "headerExtensions": headerExtensions,
                "encodings": encodings,
                "rtcp": rtcp
            };
        }

        function tryToStartTransport(transport, i) {
            var rmdesc = remoteSessionInfo.mediaDescriptions[i];

            if (!rmdesc) {
                console.log("Transport not strated at " + i);
                return;
            }

            if (!transport.transportsStarted) {
                var remoteIceParams = {
                    "usernameFragment": rmdesc.ice.ufrag,
                    "password": rmdesc.ice.password
                };

                var remoteDtlsParams = {
                    "fingerprints": [
                        {
                            "algorithm": rmdesc.dtls.fingerprintHashFunction,
                            "value": rmdesc.dtls.fingerprint
                        }
                    ]
                };

                transport.iceTransport.start(transport.iceGatherer, remoteIceParams, transport.iceRole);
                transport.dtlsTransport.start(remoteDtlsParams);
                console.log("Transports started");

                transport.transportsStarted = true;
            }
        }

        function tryToSendAndReceive() {
            if (!localSessionInfo || !remoteSessionInfo) {
                console.log("SendAndReceive: Not ready to start");
                return;
            }

            mediaTransports.forEach(function (transport, i) {
                var mdesc = localSessionInfo.mediaDescriptions[i];
                var rmdesc = remoteSessionInfo.mediaDescriptions[i];

                if (!mdesc || !rmdesc) {
                    console.log("sendAndReceive: incomplete configurations at index " + i);
                    return;
                }

                tryToStartTransport(transport, i);

                if (!transport.receiver && !(mdesc.mode == "sendonly")) {
                    console.log("create receiver");
                    transport.receiver = new RTCRtpReceiver(transport.dtlsTransport, mdesc.type);

                    var codecs = payloadsToCodecs(mdesc.payloads);
                    var rtcp = mdesc.rtcp;

                    var receiveParams = createRtpParams("", codecs, [], [{"ssrc": rmdesc.ssrcs[0]}], {"ssrc": 0, "cname": mdesc.cname, "mux": rtcp.mux});

                    try {
                        transport.receiver.receive(receiveParams);
                        setTimeout(function () {
                            _this.dispatchEvent({ "type": "track", "track": transport.receiver.track, "target": _this });
                        });
                    } catch(err) {
                        console.error("Bad receiveParams!!");
                    }
                }

                if (!transport.sender && !(mdesc.mode == "recvonly")) {
                    console.log("create sender");
                    var track = getLocalTrackById(mdesc.mediaStreamTrackId, mdesc.mediaStreamId);
                    if (!track) {
                        console.log("WARNING: track not found (" + mdesc.mediaStreamTrackId + ")");
                    } else {
                        transport.sender = new RTCRtpSender(track, transport.dtlsTransport);

                        var rcodecs = payloadsToCodecs(rmdesc.payloads);
                        var rrtcp = rmdesc.rtcp;

                        var senderParams = createRtpParams ("", rcodecs, [], [{"ssrc": mdesc.ssrcs[0]}], {"ssrc": 0, "cname": rmdesc.cname, "mux": rrtcp.mux});

                        try {
                            transport.sender.send(senderParams); 
                        } catch(err) {
                            console.error("Bad senderParams!!");
                        }
                    }
                }
            });
        }

        this.setRemoteDescription = function () {
            // backwards compatibility with callback based method
            var callbackArgsError = getArgumentsError("ortcRTCSessionDescription, function, function", 3, arguments);
            if (!callbackArgsError) {
                internalSetRemoteDescription(arguments[0]).then(arguments[1]).catch(arguments[2]);
                return;
            }

            var promiseArgsError = getArgumentsError("ortcRTCSessionDescription", 1, arguments);
            if (!promiseArgsError)
                return internalSetRemoteDescription(arguments[0]);

            throwNoMatchingSignature("setRemoteDescription", promiseArgsError, callbackArgsError);
        };

        function internalSetRemoteDescription(description) {
            checkClosedState("setRemoteDescription");

            return new Promise(function (resolve, reject) {
                enqueueOperation(function () {
                    queuedSetRemoteDescription(description, resolve, reject);
                }, true);
            });
        }

        function queuedSetRemoteDescription(description, resolve, reject) {
            var targetState = signalingStateMap[a.signalingState]["setRemote:" + description.type];
            if (!targetState) {
                completeQueuedOperation(function () {
                    reject(createError("InvalidSessionDescriptionError",
                        "setRemoteDescription: description type \"" +
                        entityReplace(description.type) + "\" invalid for the current state \"" +
                        a.signalingState + "\""));
                });
                return;
            }

            remoteSessionInfo = SDP.parse(description.sdp);
            lastSetRemoteDescriptionType = description.type;

            remoteSessionInfo.mediaDescriptions.forEach(function (mdesc, i) {
                if (!remoteSourceStatus[i])
                    remoteSourceStatus[i] = {};

                remoteSourceStatus[i].sourceExpected = mdesc.mode != "recvonly";

                if (!mdesc.ice) {
                    console.warn("setRemoteDescription: m-line " + i +
                        " is missing ICE credentials");
                    mdesc.ice = {};
                }
            });

            remoteSessionInfo.mediaDescriptions.forEach(function (mdesc, i) {
                if (mdesc.type != "audio" && mdesc.type != "video")
                    return;

                var codecs = RTCRtpSender.getCapabilities(mdesc.type).codecs;

                var filteredPayloads = mdesc.payloads.filter(function (payload) {
                    var filteredCodecs = false;
                    for (var i = 0; i < codecs.length; i++) {
                        var codec = codecs[i];
                        if (payload.encodingName.toUpperCase() == codec.name && payload.type === codec.preferredPayloadType) {
                            if ((mdesc.type == "audio"  && payload.channels === codec.numChannels) || mdesc.type == "video") {
                                filteredCodecs = true;
                                break;
                            }
                        }
                    }

                    return filteredCodecs;
                });

                mdesc.payloads = filteredPayloads;

                var isInitiator = description.type == "answer";
                ensureMediaTransport(i, false, isInitiator);

                if (mdesc.ice && mdesc.ice.candidates) {
                    candidates = mdesc.ice.candidates;
                    mdesc.ice.candidates.forEach(function (candidate) {
                        console.log("setRemoteDescription: found candidate in remote description");
                        internalAddRemoteIceCandidate(candidate, i);
                    });
                    //internalAddRemoteIceCandidate(null, i);
                }
            });

            tryToSendAndReceive();

            completeQueuedOperation(function () {
                a.signalingState = targetState;
                resolve();
            });
        };

        this.updateIce = function (configuration) {
            checkArguments("updateIce", "dictionary", 1, arguments);
            checkConfigurationDictionary(configuration);
            checkClosedState("updateIce");
        };

        this.addIceCandidate = function () {
            // backwards compatibility with callback based method
            var callbackArgsError = getArgumentsError("ortcRTCIceCandidate, function, function", 3, arguments);
            if (!callbackArgsError) {
                internalAddIceCandidate(arguments[0]).then(arguments[1]).catch(arguments[2]);
                return;
            }

            var promiseArgsError = getArgumentsError("ortcRTCIceCandidate", 1, arguments);
            if (!promiseArgsError)
                return internalAddIceCandidate(arguments[0]);

            throwNoMatchingSignature("addIceCandidate", promiseArgsError, callbackArgsError);
        };

        function internalAddIceCandidate(candidate) {
            checkClosedState("addIceCandidate");

            return new Promise(function (resolve, reject) {
                enqueueOperation(function () {
                    queuedAddIceCandidate(candidate, resolve, reject);
                });
            });
        };

        function queuedAddIceCandidate(candidate, resolve, reject) {
            if (!remoteSessionInfo) {
                completeQueuedOperation(function () {
                    reject(createError("InvalidStateError",
                        "addIceCandidate: no remote description set"));
                });
                return;
            }

            /* handle candidate values in the form <candidate> and a=<candidate>
             * to workaround https://code.google.com/p/webrtc/issues/detail?id=1142
             */
            var candidateAttribute = candidate.candidate;
            console.log(candidateAttribute);
            if (!candidateAttribute) {
                internalAddRemoteIceCandidate(null, candidate.sdpMLineIndex);
                return;
            }
            if (candidateAttribute.substr(0, 2) != "a=")
                candidateAttribute = "a=" + candidateAttribute;
            var iceInfo = SDP.parse("m=application 0 NONE\r\n" +
                candidateAttribute + "\r\n").mediaDescriptions[0].ice;
            var parsedCandidate = iceInfo && iceInfo.candidates && iceInfo.candidates[0];

            if (!parsedCandidate) {
                completeQueuedOperation(function () {
                    reject(createError("SyntaxError",
                        "addIceCandidate: failed to parse candidate attribute"));
                });
                return;
            }

            var mdesc = remoteSessionInfo.mediaDescriptions[candidate.sdpMLineIndex];
            if (!mdesc) {
                completeQueuedOperation(function () {
                    reject(createError("SyntaxError",
                        "addIceCandidate: no matching media description for sdpMLineIndex: " +
                        entityReplace(candidate.sdpMLineIndex)));
                });
                return;
            }

            if (!mdesc.ice.candidates)
                mdesc.ice.candidates = [];
            mdesc.ice.candidates.push(parsedCandidate);

            internalAddRemoteIceCandidate(parsedCandidate, candidate.sdpMLineIndex);
            completeQueuedOperation(resolve);
        };

        function internalAddRemoteIceCandidate(candidate, mdescIndex) {
            var transport = mediaTransports[mdescIndex];

            if (!candidate) {
                transport.iceTransport.addRemoteCandidate({});
                return;
            }

            var ortcCandidate = {
                "type": candidate.type,
                "foundation": candidate.foundation,
                "componentId": candidate.componentId || 1,
                "protocol": candidate.transport.toLowerCase(),
                "priority": candidate.priority,
                "ip": candidate.address,
                "port": candidate.port,
                "tcpType": candidate.tcpType,
                "relatedAddress": candidate.relatedAddress,
                "relatedPort": candidate.relatedPort
            };

            console.log("Receiving remote candidate");
            //Possible TODO: add rtcp support
            if (ortcCandidate.componentId == 2)
                return;
            transport.iceTransport.addRemoteCandidate(ortcCandidate);
        }

        this.getConfiguration = function () {
            return JSON.parse(JSON.stringify(configuration));
        };

        this.getLocalStreams = function () {
            return localStreams.slice(0);
        };

        this.getRemoteStreams = function () {
            return remoteStreams.slice(0);
        };

        this.getStreamById = function (streamId) {
            checkArguments("getStreamById", "string", 1, arguments);
            streamId = String(streamId);

            return findInArrayById(localStreams, streamId) || findInArrayById(remoteStreams, streamId);
        };

        this.addStream = function (stream) {
            checkArguments("addStream", "MediaStream", 1, arguments);
            checkClosedState("addStream");

            if (findInArrayById(localStreams, stream.id) || findInArrayById(remoteStreams, stream.id))
                return;

            localStreams.push(stream);
            setTimeout(maybeDispatchNegotiationNeeded);
        };

        this.removeStream = function (stream) {
            checkArguments("removeStream", "MediaStream", 1, arguments);
            checkClosedState("removeStream");

            var index = localStreams.indexOf(stream);
            if (index == -1)
                return;

            localStreams.splice(index, 1);
            setTimeout(maybeDispatchNegotiationNeeded);
        };

        // this.createDataChannel = function (label, dataChannelDict) {
        //     checkArguments("createDataChannel", "string", 1, arguments);
        //     checkClosedState();

        //     var initDict = dataChannelDict || {};

        //     checkDictionary("RTCDataChannelInit", initDict, {
        //         "ordered": "boolean",
        //         "maxPacketLifeTime": "number",
        //         "maxRetransmits": "number",
        //         "protocol": "string",
        //         "negotiated": "boolean",
        //         "id": "number"
        //     });

        //     var settings = {
        //         "label": String(label || ""),
        //         "ordered": getDictionaryMember(initDict, "ordered", "boolean", true),
        //         "maxPacketLifeTime": getDictionaryMember(initDict, "maxPacketLifeTime", "number", null),
        //         "maxRetransmits": getDictionaryMember(initDict, "maxRetransmits", "number", null),
        //         "protocol": getDictionaryMember(initDict, "protocol", "string", ""),
        //         "negotiated": getDictionaryMember(initDict, "negotiated", "boolean", false),
        //         "id": getDictionaryMember(initDict, "id", "number", 65535),
        //         "readyState": "connecting",
        //         "bufferedAmount": 0
        //     };

        //     if (settings.negotiated && (settings.id < 0 || settings.id > 65534)) {
        //         throw createError("SyntaxError",
        //             "createDataChannel: a negotiated channel requires an id (with value 0 - 65534)");
        //     }

        //     if (!settings.negotiated && initDict.hasOwnProperty("id")) {
        //         console.warn("createDataChannel: id should not be used with a non-negotiated channel");
        //         settings.id = 65535;
        //     }

        //     if (settings.maxPacketLifeTime != null && settings.maxRetransmits != null) {
        //         throw createError("SyntaxError",
        //             "createDataChannel: maxPacketLifeTime and maxRetransmits cannot both be set");
        //     }

        //     if (!hasDataChannels) {
        //         hasDataChannels = true;
        //         setTimeout(maybeDispatchNegotiationNeeded);
        //     }

        //     return new RTCDataChannel(settings, whenPeerHandlerCanCreateDataChannels);
        // };

        this.close = function () {
            if (a.signalingState == "closed")
                return;

            a.signalingState = "closed";
        };

        this.toString = RTCPeerConnection.toString;

        function getLocalDescription() {
            if (!localSessionInfo)
                return null;
            return new RTCSessionDescription({
                "type": lastSetLocalDescriptionType,
                "sdp": SDP.generate(localSessionInfo)
            });
        }

        function getRemoteDescription() {
            if (!remoteSessionInfo)
                return null;
            return new RTCSessionDescription({
                "type": lastSetRemoteDescriptionType,
                "sdp": SDP.generate(remoteSessionInfo)
            });
        }

        function checkConfigurationDictionary(configuration) {
            checkDictionary("RTCConfiguration", configuration, {
                "iceServers": "Array",
                "iceTransports": "string"
            });

            if (configuration.iceServers) {
                configuration.iceServers.forEach(function (iceServer) {
                    checkType("RTCConfiguration.iceServers", iceServer, "dictionary");
                    checkDictionary("RTCIceServer", iceServer, {
                        "urls": "Array | string",
                        "url": "string", // legacy support
                        "username": "string",
                        "credential": "string"
                    });
                });
            }
        }

        function checkClosedState(name) {
            if (a.signalingState == "closed")
                throw createError("InvalidStateError", name + ": signalingState is \"closed\"");
        }

        function throwNoMatchingSignature(name, primaryError, legacyError) {
            throw createError("TypeError", name + ": no matching method signature. " +
                "Alternative 1: " + primaryError + ", Alternative 2 (legacy): " + legacyError);
        }

        function maybeDispatchNegotiationNeeded() {
            if (negotiationNeededTimerHandle || queuedOperations.length
                || a.signalingState != "stable")
                return;

            var mediaDescriptions = localSessionInfo ? localSessionInfo.mediaDescriptions : [];

            var dataNegotiationNeeded = hasDataChannels
                && indexOfByProperty(mediaDescriptions, "type", "application") == -1;

            var allTracks = getAllTracks(localStreams);
            var i = 0;
            for (; i < allTracks.length; i++) {
                if (indexOfByProperty(mediaDescriptions, "mediaStreamTrackId",
                    allTracks[i].id) == -1)
                    break;
            }
            var mediaNegotiationNeeded = i < allTracks.length;

            if (!dataNegotiationNeeded && !mediaNegotiationNeeded)
                return;

            negotiationNeededTimerHandle = setTimeout(function () {
                negotiationNeededTimerHandle = 0;
                if (a.signalingState == "stable")
                    _this.dispatchEvent({ "type": "negotiationneeded", "target": _this });
            }, 0);
        }

        function maybeDispatchGatheringDone() {
            if (isAllGatheringDone() && isLocalSessionInfoComplete()) {
                _this.dispatchEvent({ "type": "icecandidate", "candidate": null,
                    "target": _this });
            }
        }

        function dispatchMediaStreamEvent(trackInfos, id) {
            var trackList = trackInfos.map(function (trackInfo) {
                return new MediaStreamTrack(trackInfo.sourceInfo, trackInfo.id);
            });

            var mediaStream = createMediaStream(trackList, id);
            remoteStreams.push(mediaStream);

            _this.dispatchEvent({ "type": "addstream", "stream": mediaStream, "target": _this });
        }

        function getAllTracks(streamList) {
            var allTracks = [];
            streamList.forEach(function (stream) {
                Array.prototype.push.apply(allTracks, stream.getTracks());
            });
            return allTracks;
        }

        function getTrackInfos(streams) {
            var trackInfos = [];
            streams.forEach(function (stream) {
                var trackInfosForStream = stream.getTracks().map(function (track) {
                    return {
                        "kind": track.kind,
                        "mediaStreamTrackId": track.id,
                        "mediaStreamId": stream.id
                    };
                });
                Array.prototype.push.apply(trackInfos, trackInfosForStream);
            });
            return trackInfos;
        }

        function getLocalTrackById(trackId, optionalStreamId) {
            for (var i = 0; i < localStreams.length; i++) {
                if (optionalStreamId && localStreams[i].id != optionalStreamId)
                    continue;

                var track = localStreams[i].getTrackById(trackId);
                if (track)
                    return track;
            }

            return null;
        };

        function findInArrayById(array, id) {
            for (var i = 0; i < array.length; i++)
                if (array[i].id == id)
                    return array[i];
            return null;
        }

        function indexOfByProperty(array, propertyName, propertyValue) {
            for (var i = 0; i < array.length; i++) {
                if (array[i][propertyName] == propertyValue)
                    return i;
            }
            return -1;
        }

        function isLocalSessionInfoComplete() {
            for (var i = 0; i < localSessionInfo.mediaDescriptions.length; i++) {
                var mdesc = localSessionInfo.mediaDescriptions[i];
                if (!mdesc.dtls.fingerprint || !mdesc.ice)
                    return false;
                if (mdesc.type == "audio" || mdesc.type == "video") {
                    if (!mdesc.ssrcs || !mdesc.cname)
                        return false;
                }
            }
            return true;
        }

        function dispatchIceCandidate(c, mdescIndex) {
            var candidateAttribute = "candidate:" + c.foundation + " " + c.componentId + " "
                + c.transport + " " + c.priority + " " + c.address + " " + c.port
                + " typ " + c.type;
            if (c.relatedAddress)
                candidateAttribute += " raddr " + c.relatedAddress + " rport " + c.relatedPort;
            if (c.tcpType)
                candidateAttribute += " tcptype " + c.tcpType;

            var candidate = new RTCIceCandidate({
                "candidate": candidateAttribute,
                "sdpMid": "",
                "sdpMLineIndex": mdescIndex
            });
            _this.dispatchEvent({ "type": "icecandidate", "candidate": candidate,
                "target": _this });
        }

        function isAllGatheringDone() {
            for (var i = 0; i < localSessionInfo.mediaDescriptions.length; i++) {
                var mdesc = localSessionInfo.mediaDescriptions[i];
                if (!mdesc.ice.gatheringDone)
                    return false;
            }
            return true;
        }
    }

    RTCPeerConnection.toString = function () {
        return "[object RTCPeerConnection]";
    };

    function RTCSessionDescription(initDict) {
        checkArguments("RTCSessionDescription", "dictionary", 0, arguments);
        if (initDict) {
            checkDictionary("RTCSessionDescriptionInit", initDict, {
                "type": "string",
                "sdp": "string"
            });
        } else
            initDict = {};

        this.type = initDict.hasOwnProperty("type") ? String(initDict["type"]) : null;
        this.sdp = initDict.hasOwnProperty("sdp") ? String(initDict["sdp"]) : null;

        this.toJSON = function () {
            return { "type": this.type, "sdp": this.sdp };
        };

        this.toString = RTCSessionDescription.toString;
    }

    RTCSessionDescription.toString = function () {
        return "[object RTCSessionDescription]";
    };

    function RTCIceCandidate(initDict) {
        checkArguments("RTCIceCandidate", "dictionary", 0, arguments);
        if (initDict) {
            checkDictionary("RTCIceCandidateInit", initDict, {
                "candidate": "string",
                "sdpMid": "string",
                "sdpMLineIndex": "number"
            });
        } else
            initDict = {};

        this.candidate = initDict.hasOwnProperty("candidate") ? String(initDict["candidate"]) : null;
        this.sdpMid = initDict.hasOwnProperty("sdpMid") ? String(initDict["sdpMid"]) : null;
        this.sdpMLineIndex = parseInt(initDict["sdpMLineIndex"]) || 0;

        this.toJSON = function () {
            return { "candidate": this.candidate, "sdpMid": this.sdpMid, "sdpMLineIndex": this.sdpMLineIndex };
        };

        this.toString = RTCIceCandidate.toString;
    }

    RTCIceCandidate.toString = function () {
        return "[object RTCIceCandidate]";
    };

    global.ortcRTCPeerConnection = RTCPeerConnection;
    global.ortcRTCSessionDescription = RTCSessionDescription;
    global.ortcRTCIceCandidate = RTCIceCandidate;

})(self);
