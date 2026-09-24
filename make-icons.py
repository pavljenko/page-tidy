#!/usr/bin/env python3
"""Генератор иконок Page Tidy.

Рисует иконку из геометрии, а не из растра: рамка и полосы считаются
в долях от размера, отрисовываются с 16-кратным увеличением и
уменьшаются с сглаживанием. Границы полос попадают ровно на границы
пикселей, поэтому на мелких размерах они остаются чёткими.

Запуск: python3 make-icons.py
"""

from PIL import Image, ImageDraw, ImageFilter

BG = (31, 36, 48, 255)
LIGHT = (230, 230, 230, 255)
RED = (255, 71, 87, 255)

# Доли от стороны иконки — сняты с исходной версии 128×128.
R_CORNER = 26 / 128
BAR_X = 25 / 128
BAR_H = 14 / 128
BAR_W = (78 / 128, 48 / 128, 78 / 128)
BAR_COLOR = (LIGHT, RED, LIGHT)
# Промежуток между полосами равен их высоте, поэтому вся группа занимает
# ровно пять высот. Её центрируют по вертикали — так на любом размере
# промежутки и поля получаются одинаковыми.

SS = 16  # коэффициент суперсэмплинга


def render(size, pad=0):
    """Иконка size×size. pad — отступ в пикселях вокруг рисунка."""
    art = size - 2 * pad
    # Геометрию округляем до целых пикселей итогового размера,
    # чтобы после уменьшения края полос были без полутонов.
    r = round(R_CORNER * art)
    bx = round(BAR_X * art)
    bh = max(1, round(BAR_H * art))
    top = round((art - 5 * bh) / 2)

    im = Image.new('RGBA', (art * SS, art * SS), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, art * SS - 1, art * SS - 1], radius=r * SS, fill=BG)

    for i, (w_ratio, color) in enumerate(zip(BAR_W, BAR_COLOR)):
        by = top + 2 * i * bh
        bw = round(w_ratio * art)
        box = [bx * SS, by * SS, (bx + bw) * SS - 1, (by + bh) * SS - 1]
        # Скругление концов заметно только на крупных размерах.
        br = round(bh * SS * 0.22) if art >= 48 else 0
        if br:
            d.rounded_rectangle(box, radius=br, fill=color)
        else:
            d.rectangle(box, fill=color)

    im = im.resize((art, art), Image.LANCZOS)
    if not pad:
        return im
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(im, (pad, pad), im)
    return out


def store_icon():
    """Значок для Chrome Web Store по требованиям магазина.

    Рисунок 96×96 на прозрачном холсте 128×128 (поля по 16 пикселей).
    Иконка тёмная, поэтому под ней лежит тонкое белое свечение —
    так её видно и на тёмном фоне. Свечение помещается в поля и
    краёв холста не касается.
    """
    art = render(96)
    canvas = Image.new('RGBA', (128, 128), (0, 0, 0, 0))

    glow = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
    glow.paste(Image.new('RGBA', (96, 96), (255, 255, 255, 255)), (16, 16), art)
    glow = glow.filter(ImageFilter.GaussianBlur(4))
    glow.putalpha(glow.getchannel('A').point(lambda a: int(a * 0.55)))

    canvas.alpha_composite(glow)
    canvas.paste(art, (16, 16), art)
    return canvas


def promo_tile():
    """Промо-картинка 440×280: насыщенный фон, крупный значок, без текста."""
    W, H = 440, 280
    tile = Image.new('RGBA', (W, H), (0, 0, 0, 255))
    d = ImageDraw.Draw(tile)
    for y in range(H):  # диагональная заливка от красного к тёмному
        for_x = y / H
        d.line([(0, y), (W, y)], fill=(
            int(255 + (31 - 255) * for_x),
            int(71 + (36 - 71) * for_x),
            int(87 + (48 - 87) * for_x),
            255,
        ))
    icon = render(176)
    tile.paste(icon, ((W - 176) // 2, (H - 176) // 2), icon)
    return tile.convert('RGB')


if __name__ == '__main__':
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    for n in (16, 32, 48, 128):
        render(n).save(os.path.join(here, 'icons', f'{n}.png'))
        print(f'icons/{n}.png')
    store_icon().save(os.path.join(here, 'store-icon-128.png'))
    print('store-icon-128.png')
    promo_tile().save(os.path.join(here, 'promo-tile-440x280.png'))
    print('promo-tile-440x280.png')
