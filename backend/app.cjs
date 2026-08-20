// Passenger startup shim: the app is pure ESM, Passenger requires a CJS entry.
import("./dist/index.js").catch((err) => {
  console.error("boot failed:", err);
  process.exit(1);
});
