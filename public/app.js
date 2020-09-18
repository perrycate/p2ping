mdc.ripple.MDCRipple.attachTo(document.querySelector('.mdc-button'));

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
    this.peerConnection = null;
    this.dataChannel = null;
    this.roomId = null;
  }

  async create() {
    document.querySelector('#createBtn').disabled = true;
    const db = firebase.firestore();
    const a = await db.collection('conns');
    const roomRef = await db.collection('conns').doc();

    console.log('Created PeerConnection with configuration: ', configuration);
    this.peerConnection = new RTCPeerConnection(configuration);

    this.dataChannel = this.peerConnection.createDataChannel("test");
    this.dataChannel.addEventListener("open", event => {
      setInterval(() => this.dataChannel.send(Date.now()), 1000);
    });
    this.dataChannel.addEventListener('message', event => {
      const sentTime = parseInt(event.data);
      let elapsedMs = Date.now() - sentTime;
      console.log(elapsedMs + " elapsed!")
      document.querySelector('#latency').innerText = `Your round trip latency in ms: ${elapsedMs}`;
    });
    this.registerPeerConnectionListeners();

    // Collect ICE Candidates for the current browser.
    const callerCandidatesCollection = roomRef.collection('callerCandidates');
    this.peerConnection.addEventListener('icecandidate', event => {
      if (!event.candidate) {
        console.log('All candidates recieved.');
        return;
      }
      console.log('Got candidate: ', event.candidate);
      callerCandidatesCollection.add(event.candidate.toJSON());
    });

    // Create p2p "room".
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    console.log('Created offer:', offer);
    const roomWithOffer = {
      'offer': {
        type: offer.type,
        sdp: offer.sdp,
      },
    };
    await roomRef.set(roomWithOffer);
    this.roomId = roomRef.id;
    console.log(`New room created with SDP offer. Room ID: ${roomRef.id}`);
    let url = new URL(roomRef.id, window.location);
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

    // Listening for remote session description.
    roomRef.onSnapshot(async snapshot => {
      const data = snapshot.data();
      if (!this.peerConnection.currentRemoteDescription && data && data.answer) {
        console.log('Got remote description: ', data.answer);
        const rtcSessionDescription = new RTCSessionDescription(data.answer);
        await this.peerConnection.setRemoteDescription(rtcSessionDescription);
      }
    });

    // Listen for remote ICE candidates.
    roomRef.collection('calleeCandidates').onSnapshot(snapshot => {
      snapshot.docChanges().forEach(async change => {
        if (change.type === 'added') {
          let data = change.doc.data();
          console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(data));
        }
      });
    });
  }

  async joinById(roomId) {
    console.log('Getting room with id: ', roomId)
    const db = firebase.firestore();
    const roomRef = db.collection('conns').doc(`${roomId}`);
    const roomSnapshot = await roomRef.get();
    console.log('Got room:', roomSnapshot.exists);

    if (roomSnapshot.exists) {
      console.log('Create PeerConnection with configuration: ', configuration);
      this.peerConnection = new RTCPeerConnection(configuration);
      console.log("Connection created.");

      this.registerPeerConnectionListeners();

      // Collect ICE candidates.
      const calleeCandidatesCollection = roomRef.collection('calleeCandidates');
      this.peerConnection.addEventListener('icecandidate', event => {
        if (!event.candidate) {
          console.log('All candidates recieved.');
          return;
        }
        console.log('Got candidate: ', event.candidate);
        calleeCandidatesCollection.add(event.candidate.toJSON());
      });

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
      roomRef.collection('callerCandidates').onSnapshot(snapshot => {
        snapshot.docChanges().forEach(async change => {
          if (change.type === 'added') {
            let data = change.doc.data();
            console.log(`Got new remote ICE candidate: ${JSON.stringify(data)}`);
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(data));
          }
        });
      });

      this.peerConnection.addEventListener('datachannel', event => {
        this.dataChannel = event.channel;
        this.dataChannel.addEventListener('message', event => {
          const msg = event.data;
          console.log("got: " + msg);
          this.dataChannel.send(msg);
        })
      });

      document.querySelector('#latency').innerText = "Connected! Your peer is measuring latency now."
    }
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
}


function init() {
  let conn = new Connection();
  document.querySelector('#createBtn').addEventListener('click', conn.create.bind(conn));
  if (window.location.pathname != "/") {
    document.querySelector('#createBtn').disabled = true;
    document.querySelector('#latency').innerText = "Connecting..."
    conn.joinById(window.location.pathname.slice(1));
  }
}

init();