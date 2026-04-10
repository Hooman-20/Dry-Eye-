import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "PASTE_YOURS",
  authDomain: "dry-eye-5f371.firebaseapp.com",
  projectId: "dry-eye-5f371",
  storageBucket: "dry-eye-5f371.firebasestorage.app",
  messagingSenderId: "743754425396",
  appId: "1:743754425396:web:7596c28d08791815165661",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
