import json, os

tree = json.load(open('tree_whale.json', encoding='utf-8'))['tree']
bypath = {t['path']: t for t in tree if t['type'] == 'blob'}

WANT = [
    ('maid-atelier/assets/maid-atelier-maid-right-v7.webp', 'whalegirl_maid_right_v7.webp'),
    ('maid-atelier/assets/maid-atelier-maid-left-v5.webp', 'whalegirl_maid_left_v5.webp'),
    ('maid-atelier/assets/icons/delighted-cutout.png', 'whalegirl_mood_delighted.png'),
    ('maid-atelier/assets/icons/determined-cutout.png', 'whalegirl_mood_determined.png'),
    ('maid-atelier/assets/icons/sleepy-cutout.png', 'whalegirl_mood_sleepy.png'),
    ('maid-atelier/assets/icons/delighted-512.png', 'whalegirl_icon512.png'),
    ('maid-atelier/preview/light.webp', 'whalegirl_ui_light.webp'),
    ('maid-atelier/preview/dark.webp', 'whalegirl_ui_dark.webp'),
    ('LICENSE', 'LICENSE_dsh-deep-whale.txt'),
    ('NOTICE', 'NOTICE_dsh-deep-whale.txt'),
    ('README.md', 'README_dsh-deep-whale.md'),
]

os.makedirs('dl', exist_ok=True)
lines = []
for path, out in WANT:
    t = bypath.get(path)
    if not t:
        print('MISSING_IN_TREE', path)
        continue
    lines.append('%s|https://api.github.com/repos/Small-tailqwq/dsh-deep-whale/git/blobs/%s|dl/%s' % (t['sha'], t['sha'], out))

open('_curl_list.txt', 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('wrote %d entries' % len(lines))
for l in lines:
    print('  ', l.split('|')[2])
