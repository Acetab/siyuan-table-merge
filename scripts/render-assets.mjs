import sharp from "sharp";

await sharp("icon.svg").resize(160, 160).png().toFile("icon.png");
console.log("Rendered icon.png from icon.svg");

await sharp("preview.svg")
  .resize(1024, 768)
  .png({compressionLevel: 9, palette: true, colors: 128})
  .toFile("preview.png");
console.log("Rendered preview.png from preview.svg");
