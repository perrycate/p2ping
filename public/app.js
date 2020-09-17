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
    console.log(a);
    const roomRef = await db.collection('conns').doc();

    console.log('Create PeerConnection with configuration: ', configuration);
    this.peerConnection = new RTCPeerConnection(configuration);

    this.dataChannel = this.peerConnection.createDataChannel("test");
    console.log("test");
    this.dataChannel.addEventListener("open", event => {
      console.log("open!");
      setInterval(() => this.dataChannel.send(Date.now()), 1000);
    });
    this.dataChannel.addEventListener('message', event => {
      const sentTime = parseInt(event.data);
      let elapsedMs = Date.now() - sentTime;
      console.log(elapsedMs + " elapsed!")
      document.querySelector('#latency').innerText = `Your round trip latency in ms: ${elapsedMs}`;
    });
    registerPeerConnectionListeners();

    // Collect ICE Candidates for the current browser.
    const callerCandidatesCollection = roomRef.collection('callerCandidates');
    this.peerConnection.addEventListener('icecandidate', event => {
      if (!event.candidate) {
        console.log('Got final candidate!');
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
    document.querySelector('#urlDisplay').innerText = `Share this link (keep this tab open) to test your peer-to-peer latency: ${new URL(roomRef.id, window.location)}`;

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
      console.log("created connection");

      registerPeerConnectionListeners();

      // Collect ICE candidates.
      const calleeCandidatesCollection = roomRef.collection('calleeCandidates');
      this.peerConnection.addEventListener('icecandidate', event => {
        if (!event.candidate) {
          console.log('Got final candidate!');
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
        console.log("recieved channel!");
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
}

let conn = new Connection();

async function hangUp(e) {

  if (conn.peerConnection) {
    conn.peerConnection.close();
  }

  document.querySelector('#cameraBtn').disabled = false;
  document.querySelector('#joinBtn').disabled = true;
  document.querySelector('#createBtn').disabled = true;
  document.querySelector('#hangupBtn').disabled = true;
  document.querySelector('#currentRoom').innerText = '';

  // Delete room on hangup.
  if (conn.roomId) {
    const db = firebase.firestore();
    const roomRef = db.collection('conns').doc(conn.roomId);
    const calleeCandidates = await roomRef.collection('calleeCandidates').get();
    calleeCandidates.forEach(async candidate => {
      await candidate.ref.delete();
    });
    const callerCandidates = await roomRef.collection('callerCandidates').get();
    callerCandidates.forEach(async candidate => {
      await candidate.ref.delete();
    });
    await roomRef.delete();
  }

  document.location.reload(true);
}

function registerPeerConnectionListeners() {
  conn.peerConnection.addEventListener('icegatheringstatechange', () => {
    console.log(
      `ICE gathering state changed: ${conn.peerConnection.iceGatheringState}`);
  });

  conn.peerConnection.addEventListener('connectionstatechange', () => {
    console.log(`Connection state change: ${conn.peerConnection.connectionState}`);
  });

  conn.peerConnection.addEventListener('signalingstatechange', () => {
    console.log(`Signaling state change: ${conn.peerConnection.signalingState}`);
  });

  conn.peerConnection.addEventListener('iceconnectionstatechange ', () => {
    console.log(
      `ICE connection state change: ${conn.peerConnection.iceConnectionState}`);
  });
}

function init() {
  document.querySelector('#hangupBtn').addEventListener('click', hangUp);
  document.querySelector('#createBtn').addEventListener('click', conn.create.bind(conn));
  if (window.location.pathname != "/") {
    document.querySelector('#createBtn').disabled = true;
    document.querySelector('#latency').innerText = "Connecting..."
    conn.joinById(window.location.pathname.slice(1));
  }
}

init();