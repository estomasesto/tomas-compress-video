import esbuild from "esbuild";
await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  external: ["obsidian"],
  minify: true,
  legalComments: "none",
  banner: { js: "/* Tomás Compress Video. Bundles Mediabunny (MPL-2.0, https://github.com/Vanilagy/mediabunny). */" },
  outfile: "main.js"
});
console.log("build OK");
