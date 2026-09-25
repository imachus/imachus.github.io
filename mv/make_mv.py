#!/usr/bin/env python3
"""Build the music video for 「まだ ここから」 from storyboard.json.

Pipeline
  1. keyframes : one still per shot, generated on FAL from the reference image
                 (character consistency) + the shot's image prompt.
  2. clips     : each keyframe animated on FAL (image-to-video) with the shot's motion prompt.
  3. assemble  : clips cut to the song's section timings with ffmpeg, song muxed in.

Every generated file is cached under work/, so re-running only makes what is missing.
Delete work/keyframes/<shot>.png (and work/clips/<shot>.mp4) to regenerate a shot.

Usage
  export FAL_KEY=...                           # fal.ai API key
  python3 make_mv.py --ref assets/reference.png            # full run
  python3 make_mv.py --ref assets/reference.png --stage keyframes   # stills only, to review
  python3 make_mv.py --video-mode kenburns     # cheap animatic from the stills (no video model)
  python3 make_mv.py --dry-run                 # placeholder stills, no FAL calls (pipeline test)
"""
import argparse
import concurrent.futures as cf
import json
import os
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
FPS = 30
W, H = 1920, 1080

IMAGE_MODEL = "fal-ai/nano-banana/edit"
VIDEO_MODEL = "fal-ai/kling-video/v2.5-turbo/pro/image-to-video"


def ffmpeg_exe():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def run_ffmpeg(args):
    cmd = [ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", *args]
    subprocess.run(cmd, check=True)


def load_plan(path):
    sb = json.loads(Path(path).read_text(encoding="utf-8"))
    duration = sb["song"]["duration"]
    sections = sb["sections"]
    shots = []
    for i, sec in enumerate(sections):
        start = sec["start"]
        end = sections[i + 1]["start"] if i + 1 < len(sections) else duration
        weights = [s.get("weight", 1.0) for s in sec["shots"]]
        total = sum(weights)
        t = start
        for shot, w in zip(sec["shots"], weights):
            dur = (end - start) * w / total
            shots.append({**shot, "section": sec["id"], "start": t, "end": t + dur})
            t += dur
    # Snap boundaries to the frame grid so the video never drifts from the song.
    for s in shots:
        s["frames"] = round(s["end"] * FPS) - round(s["start"] * FPS)
    return sb, shots


class Manifest:
    def __init__(self, path):
        self.path = path
        self.data = json.loads(path.read_text()) if path.exists() else {}

    def get(self, key):
        return self.data.get(key)

    def set(self, key, value):
        self.data[key] = value
        self.path.write_text(json.dumps(self.data, indent=2, ensure_ascii=False))


def download(url, dest):
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=300) as r, open(tmp, "wb") as f:
        shutil.copyfileobj(r, f)
    tmp.rename(dest)


# ---------------------------------------------------------------- keyframes

def keyframe_prompt(sb, shot):
    return (
        f"Use the person in the reference image as the main character: {sb['character']}. "
        f"Scene: {shot['image']} "
        f"Style: {sb['style']}. Avoid: {sb['negative']}."
    )


def make_keyframe_fal(sb, shot, ref_url, dest, model):
    import fal_client
    args = {
        "prompt": keyframe_prompt(sb, shot),
        "image_urls": [ref_url],
        "num_images": 1,
        "output_format": "png",
        "aspect_ratio": "16:9",
    }
    try:
        res = fal_client.subscribe(model, arguments=args)
    except fal_client.FalClientHTTPError as e:
        if e.status_code != 422:
            raise
        args.pop("aspect_ratio")  # older model versions reject it; we crop to 16:9 later
        res = fal_client.subscribe(model, arguments=args)
    download(res["images"][0]["url"], dest)


def make_keyframe_placeholder(shot, dest):
    from PIL import Image, ImageDraw, ImageFont
    hue = (hash(shot["section"]) % 360) / 360
    import colorsys
    r, g, b = (int(c * 255) for c in colorsys.hsv_to_rgb(hue, 0.35, 0.55))
    img = Image.new("RGB", (W, H), (r, g, b))
    d = ImageDraw.Draw(img)
    font = None
    for cand in ["/usr/share/fonts/opentype/unifont/unifont_jp.otf",
                 "/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc",
                 "C:/Windows/Fonts/meiryo.ttc"]:
        if Path(cand).exists():
            font = ImageFont.truetype(cand, 64)
            break
    font = font or ImageFont.load_default()
    d.text((80, 80), f"{shot['id']}  [{shot['section']}]", fill="white", font=font)
    d.text((80, 200), shot.get("note", ""), fill="white", font=font)
    d.text((80, 320), f"{shot['start']:.2f}s - {shot['end']:.2f}s", fill="white", font=font)
    img.save(dest)


# ---------------------------------------------------------------- clips

def clip_seconds(shot):
    return "5" if shot["end"] - shot["start"] <= 5.0 else "10"


def make_clip_fal(sb, shot, kf_url, dest, model):
    import fal_client
    res = fal_client.subscribe(model, arguments={
        "prompt": f"{shot['motion']} Cinematic, natural and subtle movement, consistent character.",
        "image_url": kf_url,
        "duration": clip_seconds(shot),
        "negative_prompt": sb["negative"] + ", blur, morphing, flicker",
        "cfg_scale": 0.5,
    })
    download(res["video"]["url"], dest)


def make_clip_kenburns(shot, keyframe, dest, index):
    frames = shot["frames"] + FPS  # a little spare; assembly trims to the exact length
    zoom_in = index % 2 == 0
    z = f"1+0.08*on/{frames}" if zoom_in else f"1.08-0.08*on/{frames}"
    vf = (f"scale={W * 2}:{H * 2}:force_original_aspect_ratio=increase,crop={W * 2}:{H * 2},"
          f"zoompan=z='{z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps={FPS}")
    run_ffmpeg(["-loop", "1", "-i", str(keyframe), "-vf", vf, "-frames:v", str(frames),
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", str(dest)])


# ---------------------------------------------------------------- assembly

def normalize(shot, clip, dest):
    """Scale/crop to 1920x1080@30 and cut to exactly the shot's frame count.
    A clip that is too short is slowed down (up to 1.6x) and then held on its last frame."""
    probe = subprocess.run([ffmpeg_exe(), "-i", str(clip)], capture_output=True, text=True).stderr
    src = 0.0
    for line in probe.splitlines():
        if "Duration:" in line:
            h, m, s = line.split("Duration:")[1].split(",")[0].strip().split(":")
            src = int(h) * 3600 + int(m) * 60 + float(s)
    need = shot["frames"] / FPS
    stretch = min(max(need / src, 1.0), 1.6) if src else 1.0
    vf = (f"setpts={stretch:.4f}*PTS,scale={W}:{H}:force_original_aspect_ratio=increase,"
          f"crop={W}:{H},fps={FPS},setsar=1,tpad=stop_mode=clone:stop_duration={need:.3f}")
    run_ffmpeg(["-i", str(clip), "-vf", vf, "-an", "-frames:v", str(shot["frames"]),
                "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p",
                "-r", str(FPS), str(dest)])


def write_lyrics(srt_in, srt_out):
    """Copy the song's timed lyrics without the [Section] marker cues (for upload as captions)."""
    blocks = Path(srt_in).read_text(encoding="utf-8").strip().split("\n\n")
    out = []
    for b in blocks:
        lines = b.strip().split("\n")
        if len(lines) < 3 or lines[2].startswith("["):
            continue
        out.append(f"{len(out) + 1}\n{lines[1]}\n" + "\n".join(lines[2:]))
    Path(srt_out).write_text("\n\n".join(out) + "\n", encoding="utf-8")


def assemble(sb, shots, clips_dir, work, out_path, burn_subs, font):
    norm_dir = work / "norm"
    norm_dir.mkdir(exist_ok=True)
    for shot in shots:
        dest = norm_dir / f"{shot['id']}.mp4"
        src = clips_dir / f"{shot['id']}.mp4"
        if not dest.exists() or dest.stat().st_mtime < src.stat().st_mtime:
            normalize(shot, src, dest)
    listing = work / "concat.txt"
    listing.write_text("".join(f"file '{(norm_dir / (s['id'] + '.mp4')).as_posix()}'\n" for s in shots))
    silent = work / "video_only.mp4"
    run_ffmpeg(["-f", "concat", "-safe", "0", "-i", str(listing), "-c", "copy", str(silent)])

    lyrics = out_path.with_name("lyrics.srt")
    write_lyrics(HERE / sb["song"]["lyrics_srt"], lyrics)

    dur = sb["song"]["duration"]
    vf = f"fade=t=in:st=0:d=1.5,fade=t=out:st={dur - 3:.2f}:d=3"
    if burn_subs:
        style = f"FontName={font},FontSize=22,Outline=1.2,Shadow=0,MarginV=40"
        vf += f",subtitles='{lyrics.as_posix()}':force_style='{style}'"
    run_ffmpeg(["-i", str(silent), "-i", str(HERE / sb["song"]["audio"]),
                "-map", "0:v", "-map", "1:a", "-vf", vf,
                "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "256k", "-t", f"{dur:.3f}", "-movflags", "+faststart",
                str(out_path)])


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--storyboard", default=str(HERE / "storyboard.json"))
    ap.add_argument("--ref", help="reference image of the protagonist (required unless --dry-run)")
    ap.add_argument("--stage", choices=["keyframes", "clips", "all"], default="all")
    ap.add_argument("--video-mode", choices=["fal", "kenburns"], default="fal")
    ap.add_argument("--image-model", default=IMAGE_MODEL)
    ap.add_argument("--video-model", default=VIDEO_MODEL)
    ap.add_argument("--only", nargs="*", help="limit generation to these shot ids")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--burn-subs", action="store_true", help="burn lyrics into the picture")
    ap.add_argument("--font", default="Noto Sans CJK JP")
    ap.add_argument("--dry-run", action="store_true", help="placeholders, no FAL calls")
    ap.add_argument("--work", default=str(HERE / "work"))
    ap.add_argument("--out", default=str(HERE / "out" / "mv.mp4"))
    a = ap.parse_args()

    sb, shots = load_plan(a.storyboard)
    work = Path(a.work)
    if a.dry_run:
        work = work.with_name(work.name + "_dryrun")
        a.video_mode = "kenburns"
    kf_dir, clip_dir = work / "keyframes", work / "clips"
    for d in (kf_dir, clip_dir):
        d.mkdir(parents=True, exist_ok=True)
    out = Path(a.out)
    if a.dry_run:
        out = out.with_name(out.stem + "_dryrun.mp4")
    out.parent.mkdir(parents=True, exist_ok=True)
    manifest = Manifest(work / "manifest.json")
    todo = [s for s in shots if not a.only or s["id"] in a.only]

    uses_fal = not a.dry_run
    if uses_fal:
        if not os.environ.get("FAL_KEY"):
            sys.exit("FAL_KEY is not set")
        if not a.ref:
            sys.exit("--ref <reference image> is required")
        import fal_client
        ref_key = f"upload:{Path(a.ref).resolve()}:{Path(a.ref).stat().st_mtime}"
        ref_url = manifest.get(ref_key)
        if not ref_url:
            ref_url = fal_client.upload_file(a.ref)
            manifest.set(ref_key, ref_url)

    print(f"{len(shots)} shots, {sb['song']['duration']:.1f}s")

    def keyframe(shot):
        dest = kf_dir / f"{shot['id']}.png"
        if dest.exists():
            return
        if a.dry_run:
            make_keyframe_placeholder(shot, dest)
        else:
            make_keyframe_fal(sb, shot, ref_url, dest, a.image_model)
        print(f"  keyframe {shot['id']}")

    def clip(shot, index):
        dest = clip_dir / f"{shot['id']}.mp4"
        kf = kf_dir / f"{shot['id']}.png"
        if dest.exists() and dest.stat().st_mtime >= kf.stat().st_mtime:
            return
        if a.video_mode == "kenburns":
            make_clip_kenburns(shot, kf, dest, index)
        else:
            import fal_client
            key = f"upload:{kf}:{kf.stat().st_mtime}"
            url = manifest.get(key) or fal_client.upload_file(kf)
            manifest.set(key, url)
            make_clip_fal(sb, shot, url, dest, a.video_model)
        print(f"  clip {shot['id']} ({clip_seconds(shot) if a.video_mode == 'fal' else 'kenburns'})")

    def run_all(fn, items):
        failed = []
        with cf.ThreadPoolExecutor(a.workers) as ex:
            futs = {ex.submit(fn, *it): it[0]["id"] for it in items}
            for f in cf.as_completed(futs):
                if f.exception():
                    failed.append(futs[f])
                    print(f"  FAILED {futs[f]}: {f.exception()}", file=sys.stderr)
        if failed:
            sys.exit(f"{len(failed)} shot(s) failed: {', '.join(failed)} — re-run to retry")

    print("[1/3] keyframes")
    run_all(keyframe, [(s,) for s in todo])
    if a.stage == "keyframes":
        return
    print("[2/3] clips")
    run_all(clip, [(s, shots.index(s)) for s in todo])
    if a.stage == "clips" or a.only:
        return
    print("[3/3] assemble")
    assemble(sb, shots, clip_dir, work, out, a.burn_subs, a.font)
    print(f"done: {out}")


if __name__ == "__main__":
    main()
