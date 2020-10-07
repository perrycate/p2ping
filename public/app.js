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

class Connection {
  constructor() {
    this.dataChannel = null;
    this.roomId = null;

    console.log('Creating PeerConnection with configuration: ', configuration);
    this.peerConnection = new RTCPeerConnection(configuration);
    console.log('Created.');

    this.db = firebase.firestore();
  }

  async create() {
    const roomRef = await this.db.collection('conns').doc();
    this.dataChannel = this.peerConnection.createDataChannel("test");

    this.registerPeerConnectionListeners();

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

    // Listen for remote session description.
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

    this.dataChannel.addEventListener("open", event => {
      setInterval(() => this.dataChannel.send(Date.now()), 1000);
    });
    this.dataChannel.addEventListener('message', event => {
      const sentTime = parseInt(event.data);
      let elapsedMs = Date.now() - sentTime;
      console.log(elapsedMs + " elapsed!")
      document.querySelector('#latency').innerText = `Your round trip latency in ms: ${elapsedMs}`;
    });
  }

  async joinById(roomId) {
    console.log('Getting room with id: ', roomId)
    const roomRef = this.db.collection('conns').doc(`${roomId}`);
    const roomSnapshot = await roomRef.get();
    console.log('Got room:', roomSnapshot.exists);

    if (!roomSnapshot.exists) {
      console.log(`Unable to connect: room with id ${roomId} not found.`)
      return
    }

    this.registerPeerConnectionListeners();

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

    this.peerConnection.addEventListener('datachannel', event => {
      // If we got a data channel, we know we're connected.
      document.querySelector('#userPrompt').innerText = "Connected! Your peer is measuring latency now."
      this.dataChannel = event.channel;
      this.dataChannel.addEventListener('message', event => {
        const msg = event.data;
        console.log("got: " + msg);
        this.dataChannel.send(msg);
      })
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

  registerPeerConnectionListeners() {
    this.peerConnection.addEventListener('icegatheringstatechange', () => {
      console.log(
        `ICE gathering state changed: ${this.peerConnection.iceGatheringState}`);
    });

    this.peerConnection.addEventListener('connectionstatechange', () => {
      console.log(`Connection state change: ${this.peerConnection.connectionState}`);
    });

    this.peerConnection.addEventListener('signalingstatechange', () => {
      console.log(`Signaling state change: ${this.peerConnection.signalingState}`);
    });

    this.peerConnection.addEventListener('iceconnectionstatechange ', () => {
      console.log(
        `ICE connection state change: ${this.peerConnection.iceConnectionState}`);
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


function init() {
  let conn = new Connection();
  let id = window.location.pathname.slice(1);

  if (id == "") {
    // A user is visiting the base URL. Set up a connection and a URL for users to connect to.
    conn.create();
    return
  }
  document.querySelector('#userPrompt').innerText = "Connecting..."
  conn.joinById(id);
}

init();