const admin = require('firebase-admin');

admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
const fs = admin.firestore();

const SONGS = [
  "Stay", "Funk E Zekial", "Landing", "French Cafe", "Overtired", "Totally", "On the Rise", "Couldn't We All",
  "F.U.", "Melting Lights", "Julia", "Schwanthem", "Zydeko", "Time To Ride", "Sunny Day", "Moonwalk", "Horizon",
  "Lightning", "White Night", "Live Life", "Upfunk", "Live It Up", "Walk Outside", "Burning Up My Time",
  "Condenser", "Fade Fast", "Pop Off", "Bad For You", "Whoopie", "Kiwi", "Interzood", "Penguins", "Fun in Funk",
  "Somethin' for Ya", "Ocean Flows", "The Liquid", "Porcupine", "Henrietta", "Too Long", "Doc", "Fox and Toad",
  "Offshoot", "Posideon", "King Kong", "Dawn a New Day", "High as Five", "Sail On", "Avalanche", "Fortress",
  "Yo Soy Fiesta", "Overrun", "Havana", "Snake Eyes", "Skipjack", "Elephante", "Move Like That", "Lost in Line",
  "Sir Real", "Water", "Lowdown", "Su Casa", "Distant Times", "Paperboy", "Whirled", "Beanstalk", "Indiglo",
  "The Town", "Alright Tonight", "Day In Time", "My Own Way", "Fall In Place", "Skinner", "Beneath The Surface",
  "Let The Boogie Out", "Overtime", "Sorcerer", "Feelin' Fine", "Yesterday In Time", "Calm Before the Storm",
  "Underworld", "Right Track", "Hell Yeah", "In the Bubble", "Feed The Fire", "Hit the Ground Runnin'",
  "Fantasy", "Twitch", "Mine", "Donkey Hotel", "Undivided", 
   "Bloodshot Rose", "Blue Light", "Cliffs", "Dome People",
  "Drunk People", "Dutchmaster", "E Funk", "Feet on the Ground", "Funkijam", "Go With it", "J-Town",
  "Miyagi", "Montreal", "Philosophy", "Puddles", "Say Cheese", "Show Me", "Spaced", "Spacejam",
  "Steal the Shade", "The Hop", "The Labrynth", "The Switch", "The Turn", "This is that", "Treat Yourself",
  "Weightless", "Where Are We Going?", "Winters Splinters", "Wireless", "New Song"
];

(async () => {
  // health doc
  await fs.collection('_health').doc('ping').set(
    { ok: true, ts: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  // songs (batched)
  let batch = fs.batch();
  let count = 0;

  for (const nameRaw of SONGS) {
    const name = String(nameRaw).trim();
    if (!name) continue;

    const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '');
    batch.set(fs.collection('songs').doc(id || name), {
      name,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    count++;
    if (count % 400 === 0) { // batch limit is 500; stay safe
      await batch.commit();
      batch = fs.batch();
    }
  }

  await batch.commit();
  console.log('Seeded songs:', count);
})();
