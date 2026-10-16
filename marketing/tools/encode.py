"""Encode rendered demo frames as a GIF (README) and an MP4 (video and blog).

Usage: python encode.py <render-out-dir> <demo.gif> <demo.mp4> [gif-width]
Needs: pip install pillow imageio-ffmpeg
"""
import json
import subprocess
import sys
import tempfile
from pathlib import Path

import imageio_ffmpeg
from PIL import Image


def encode_gif(frames_dir: Path, manifest: list, out: Path, width: int) -> None:
    frames = []
    for item in manifest:
        image = Image.open(frames_dir / item["file"]).convert("RGB")
        if image.width != width:
            image = image.resize((width, round(image.height * width / image.width)), Image.LANCZOS)
        frames.append(image)
    # One palette for every frame avoids flicker. Build it from a strip of frames that
    # together show every screen and colour, and skip dithering so text stays crisp.
    sample = frames[:: max(1, len(frames) // 8)]
    strip = Image.new("RGB", (width, sum(f.height for f in sample)))
    y = 0
    for f in sample:
        strip.paste(f, (0, y))
        y += f.height
    palette = strip.quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    indexed = [f.quantize(palette=palette, dither=Image.Dither.NONE) for f in frames]
    indexed[0].save(out, save_all=True, append_images=indexed[1:], loop=0, optimize=True,
                    duration=[item["ms"] for item in manifest], disposal=1)


def encode_mp4(frames_dir: Path, manifest: list, out: Path) -> None:
    # The concat demuxer shows each image for its duration. It needs the last entry
    # repeated to honour that duration, and -t trims the extra copy it then adds.
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as listing:
        for item in manifest:
            listing.write(f"file '{(frames_dir / item['file']).resolve()}'\nduration {item['ms'] / 1000:.3f}\n")
        listing.write(f"file '{(frames_dir / manifest[-1]['file']).resolve()}'\n")
    seconds = sum(item["ms"] for item in manifest) / 1000
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
                    "-i", listing.name, "-vf", "fps=30,format=yuv420p", "-t", f"{seconds:.3f}", "-c:v", "libx264",
                    "-preset", "slow", "-crf", "16", "-tune", "stillimage", "-movflags", "+faststart", str(out)],
                   check=True)
    Path(listing.name).unlink()


def main() -> None:
    render_dir, gif_out, mp4_out = (Path(a) for a in sys.argv[1:4])
    width = int(sys.argv[4]) if len(sys.argv) > 4 else 1600
    manifest = json.loads((render_dir / "demo" / "manifest.json").read_text())
    encode_gif(render_dir / "demo" / "gif", manifest, gif_out, width)
    encode_mp4(render_dir / "demo" / "video", manifest, mp4_out)
    seconds = sum(item["ms"] for item in manifest) / 1000
    print(f"{gif_out}: {gif_out.stat().st_size / 1e6:.1f} MB, {mp4_out}: {mp4_out.stat().st_size / 1e6:.1f} MB, {seconds:.1f} s")


if __name__ == "__main__":
    main()
