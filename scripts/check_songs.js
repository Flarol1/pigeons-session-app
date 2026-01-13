const admin = require('firebase-admin');

admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
const db = admin.firestore();

(async () => {
  const snap = await db.collection('songs').get();
  console.log('Songs:', snap.size);
})();
