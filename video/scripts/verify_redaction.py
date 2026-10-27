import subprocess, sys
src = sys.argv[1]; W, H = 1920, 1080; fsz = W * H * 3
p = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', src, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
def at(b, x, y):
    i = (y * W + x) * 3; return b[i], b[i+1], b[i+2]
n = 0; login = 0; bad = []
while True:
    b = p.stdout.read(fsz)
    if len(b) < fsz: break
    orr = sum(1 for x, y in [(892, 325), (912, 340), (902, 318), (902, 346)] if (lambda c: c[0] > 220 and 120 < c[1] < 190 and c[2] < 80)(at(b, x, y)))
    if orr >= 3:
        login += 1
        dark = sum(1 for y in range(308, 343, 2) for x in range(490, 847, 2) if at(b, x, y)[0] < 200)
        if dark: bad.append((n, dark))
    n += 1
print(src.split('/')[-1], 'frames', n, 'login-page frames', login, 'frames with text in email field', bad[:10])
