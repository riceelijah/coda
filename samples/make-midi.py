"""Generate the MIDI samples used by test.html. Run: python3 samples/make-midi.py"""
import struct, pathlib

HERE = pathlib.Path(__file__).parent

def vlq(n):
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.insert(0, (n & 0x7F) | 0x80)
        n >>= 7
    return bytes(out)

def track(events):
    """events: list of (abs_tick, bytes). Uses running status where possible."""
    data, last, status = b"", 0, None
    for tick, ev in sorted(events, key=lambda e: e[0]):
        data += vlq(tick - last)
        last = tick
        if ev[0] < 0xF0 and ev[0] == status:
            data += ev[1:]  # running status
        else:
            data += ev
            status = ev[0] if ev[0] < 0xF0 else None
    data += vlq(0) + b"\xff\x2f\x00"
    return b"MTrk" + struct.pack(">I", len(data)) + data

def notes(ch, items, q):
    """items: (midi, start_quarters, end_quarters). Note-off as note-on velocity 0."""
    ev = []
    for m, a, b in items:
        ev.append((int(a * q), bytes([0x90 | ch, m, 80])))
        ev.append((int(b * q), bytes([0x90 | ch, m, 0])))
    return ev

def smf(fmt, division, tracks):
    return b"MThd" + struct.pack(">IHHH", 6, fmt, len(tracks), division) + b"".join(tracks)

Q = 96  # ticks per quarter (scaled to 480 on import)
name = lambda s: (0, b"\xff\x03" + vlq(len(s)) + s.encode())
meta = [(0, b"\xff\x51\x03\x07\xa1\x20"),      # 500000 us/quarter = 120 bpm
        (0, b"\xff\x58\x04\x04\x02\x18\x08"),  # 4/4
        (0, b"\xff\x59\x02\x01\x00")]          # G major
sysex = (0, b"\xf0\x05\x7e\x7f\x09\x01\xf7")  # GM reset; must be skipped cleanly
melody = [name("Melody"), sysex] + notes(0, [(67, 0, 1), (69, 1, 2), (71, 2, 3), (74, 3, 5), (78, 6, 8)], Q)
bass = [name("Bass")] + notes(1, [(43, 0, 4), (50, 0, 4), (48, 4, 6), (50, 6, 8)], Q)
(HERE / "scale.mid").write_bytes(smf(1, Q, [track(meta), track(melody), track(bass)]))

# format 0: one track, a melody on channel 1 and drums on channel 10 (skipped on import)
f0 = notes(0, [(60, 0, 1), (64, 1, 2)], Q) + notes(9, [(36, 0, 1), (38, 1, 2)], Q)
(HERE / "format0.mid").write_bytes(smf(0, Q, [track(f0)]))
print("wrote scale.mid, format0.mid")
