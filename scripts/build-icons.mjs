import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// ImageMagick only resizes and encodes the approved artwork; it does not redraw it.
const publicDirectory = fileURLToPath(new URL("../public/", import.meta.url));
const brandDirectory = join(publicDirectory, "brand");
const iconDirectory = join(publicDirectory, "icons");
const master = join(brandDirectory, "solveathome-icon-master.png");
mkdirSync(iconDirectory, { recursive: true });

const exports = [
  [16, "icons/favicon-16.png"],
  [32, "icons/favicon-32.png"],
  [48, "icons/favicon-48.png"],
  [180, "icons/apple-touch-icon.png"],
  [192, "icons/icon-192.png"],
  [512, "icons/icon-512.png"],
  [512, "icons/icon-maskable-512.png"],
  [256, "brand/github-avatar-256.png"],
  [512, "brand/github-avatar-512.png"],
  [1024, "brand/github-avatar-1024.png"],
];

try {
  for (const [size, destination] of exports) {
    execFileSync("magick", [master, "-filter", "Lanczos", "-resize", `${size}x${size}`, "-strip", join(publicDirectory, destination)]);
  }
  execFileSync("magick", [
    join(iconDirectory, "favicon-16.png"),
    join(iconDirectory, "favicon-32.png"),
    join(iconDirectory, "favicon-48.png"),
    join(iconDirectory, "favicon.ico"),
  ]);
  console.log(`Exported ${exports.length} PNGs and a multi-resolution favicon.ico.`);
} catch (error) {
  if (error.code === "ENOENT") {
    console.error("Install ImageMagick (the magick command) to regenerate the icon exports.");
    process.exitCode = 1;
  } else {
    throw error;
  }
}
