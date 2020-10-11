"use strict";

const configuration = {
  iceServers: [
    {
      urls: [
        'stun:stun1.l.google.com:19302',
        'stun:stun2.l.google.com:19302',
      ],
    },
  ],
  iceCandidatePoolSize: 10,
};

// Contains data to be echo'd to the remote peer and back to determine latency.
class Ping {
  constructor(origin, timestamp) {
    this.origin = origin
    this.timestamp = timestamp
  }

  toString() {
    return JSON.stringify(this)
  }
}

class Connection {
  constructor(id) {
    this.dataChannel = null;
    this.id = id;

    console.log('Creating PeerConnection with configuration: ', configuration);
    this.peerConnection = new RTCPeerConnection(configuration);
    this.peerConnection.addEventListener('datachannel', event => {
      // If we got a data channel, we know we're connected.
      document.querySelector('#userPrompt').innerText = "Connected! Your peer is measuring latency now."
      this.dataChannel = event.channel;
      this.registerDataChannelListeners();
    });
    console.log('Created.');

    this.db = firebase.firestore();
  }

  async create() {
    const roomRef = await this.db.collection('conns').doc();
    this.dataChannel = this.peerConnection.createDataChannel("test");
    this.registerDataChannelListeners();

    registerPeerConnectionListeners(this.peerConnection);

    // Collect ICE Candidates for the current browser.
    this.collectIceCandidatesInto(roomRef.collection('callerCandidates'))

    // Create SDP Offer.
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    console.log('Created offer:', offer);
    const roomWithOffer = {
      offer: {
        type: offer.type,
        sdp: offer.sdp,
      },
    };
    await roomRef.set(roomWithOffer);
    console.log(`New room created with SDP offer. Room ID: ${roomRef.id}`);

    // Display URL.
    let url = new URL(roomRef.id, window.location);
    this.displayShareLink(url);

    // Listen for remote SDP answer.
    roomRef.onSnapshot(async snapshot => {
      const data = snapshot.data();
      if (!this.peerConnection.currentRemoteDescription && data && data.answer) {
        console.log('Got remote description: ', data.answer);
        const rtcSessionDescription = new RTCSessionDescription(data.answer);
        await this.peerConnection.setRemoteDescription(rtcSessionDescription);
      }
    });

    // Listen for remote ICE candidates.
    roomRef.collection('calleeCandidates').onSnapshot(this.addRemoteCandidateIfExists.bind(this));

  }

  async join() {
    console.log('Getting room with id: ', this.id)
    const roomRef = this.db.collection('conns').doc(`${this.id}`);
    const roomSnapshot = await roomRef.get();
    console.log('Got room:', roomSnapshot.exists);

    if (!roomSnapshot.exists) {
      console.log(`Unable to connect: room with id ${this.id} not found.`)
      return
    }

    registerPeerConnectionListeners(this.peerConnection);

    // Collect ICE candidates.
    this.collectIceCandidatesInto(roomRef.collection('calleeCandidates'))

    // Create SDP answer.
    const offer = roomSnapshot.data().offer;
    console.log('Got offer:', offer);
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.peerConnection.createAnswer();
    console.log('Created answer:', answer);
    await this.peerConnection.setLocalDescription(answer);
    const roomWithAnswer = {
      answer: {
        type: answer.type,
        sdp: answer.sdp,
      },
    };
    await roomRef.update(roomWithAnswer);

    // Listen for remote ICE candidates.
    roomRef.collection('callerCandidates').onSnapshot(this.addRemoteCandidateIfExists.bind(this));

  }

  handlePing(p) {
    // Echo back anything that we didn't send.
    if (p.origin !== this.id) {
      console.log("echoing back", p)
      this.dataChannel.send(p);
      return
    }

    // Calculate latency by how long it took our own pings to be echo'd back to us.
    let elapsedMs = Date.now() - p.timestamp;
    console.log(elapsedMs + " elapsed!")
    document.querySelector('#latency').innerText = `Your round trip latency in ms: ${elapsedMs}`;
  }

  registerDataChannelListeners() {
    this.dataChannel.addEventListener('message', event => {
      this.handlePing(Object.assign(new Ping, JSON.parse(event.data)));
    })

    this.dataChannel.addEventListener('open', () => {
      setInterval(() => {
        let p = new Ping(this.id, Date.now())
        this.dataChannel.send(p)
      }, 1000);
    });
  }

  collectIceCandidatesInto(collection) {
    this.peerConnection.addEventListener('icecandidate', event => {
      if (!event.candidate) {
        console.log('All candidates recieved.');
        return;
      }
      console.log('Got candidate: ', event.candidate);
      collection.add(event.candidate.toJSON());
    });
  }

  addRemoteCandidateIfExists(snapshot) {
    snapshot.docChanges().forEach(async change => {
      if (change.type === 'added') {
        let data = change.doc.data();
        console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(data));
      }
    });
  }

  // Right now this is going to be my catchall for DOM manipulation stuff.
  // Not putting too much thought into this since it'll be replaced with react before too long anyway.
  displayShareLink(url) {
    document.querySelector('#userPrompt').innerText = `Share this link (keep this tab open) to test your peer-to-peer latency:`;
    document.querySelector('#urlDisplay').innerText = url;
    let copyButton = document.querySelector('#copyBtn');
    copyButton.onclick = function (event) {
      console.log(event)
      navigator.clipboard.writeText(url).then(function () {
        document.querySelector('#copyDisplay').innerText = "URL Copied!";
      }, function (err) {
        document.querySelector('#copyDisplay').innerText = "Failed to copy URL. Consider filing a bug on Github.";
        console.log(err);
      });
    };
    copyButton.style.display = "inline";

  }
}

// Sets up some helpful ICE-related logging.
function registerPeerConnectionListeners(peerConnection) {
  peerConnection.addEventListener('icegatheringstatechange', () => {
    console.log(
      `ICE gathering state changed: ${peerConnection.iceGatheringState}`);
  });

  peerConnection.addEventListener('connectionstatechange', () => {
    console.log(`Connection state change: ${peerConnection.connectionState}`);
  });

  peerConnection.addEventListener('signalingstatechange', () => {
    console.log(`Signaling state change: ${peerConnection.signalingState}`);
  });

  peerConnection.addEventListener('iceconnectionstatechange ', () => {
    console.log(
      `ICE connection state change: ${peerConnection.iceConnectionState}`);
  });
}

function init() {
  let id = window.location.pathname.slice(1);
  let conn = new Connection(id);

  if (id == "") {
    // A user is visiting the base URL. Set up a connection and a URL for users to connect to.
    conn.create();
    return
  }
  document.querySelector('#userPrompt').innerText = "Connecting..."
  conn.join();
}

init();