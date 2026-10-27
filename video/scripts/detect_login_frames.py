"""Frames whose layout is the AutomationExercise /login page: the orange OR badge is at (902,332)."""
import subprocess, sys, json
src = sys.argv[1]; W, H = 1920, 1080; fsz = W * H * 3
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
def orange(b, x, y):
    i = (y * W + x) * 3; r, g, bl = b[i], b[i+1], b[i+2]
    return r > 220 and 120 < g < 190 and bl < 80
n = 0; hits = []
while True:
    b = p.stdout.read(fsz)
    if len(b) < fsz: break
    if sum(orange(b, x, y) for x, y in [(902, 332), (892, 325), (912, 340), (902, 318), (902, 346)]) >= 4: hits.append(n)
    n += 1
rng = []
for f in hits:
    if rng and f <= rng[-1][1] + 1: rng[-1][1] = f
    else: rng.append([f, f])
print(json.dumps({'frames': n, 'ranges': rng}))
