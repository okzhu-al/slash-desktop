from PIL import Image, ImageDraw, ImageFilter
import math

size = 1024
icon = Image.new('RGBA', (size, size), (0, 0, 0, 255))
draw = ImageDraw.Draw(icon)

# 1. Stunning Background Gradient (Klein Blue to Deep Night Blue)
for y in range(size):
    # Interpolate from #0050FF (0, 80, 255) to #001A80 (0, 26, 128)
    progress = y / size
    r = int(0)
    g = int(80 * (1 - progress) + 26 * progress)
    b = int(255 * (1 - progress) + 128 * progress)
    draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

# 2. The Internal Folded Corner (Mac Squircle Compatible)
# We place the fold at the top-right. macOS squircle radius is ~231px.
# We make the fold just big enough to look perfect when clipped by macOS.
fold_size = 280
fold_x = size - fold_size
fold_y = fold_size

# Shadow for the fold
shadow = Image.new('RGBA', (size, size), (0,0,0,0))
shadow_draw = ImageDraw.Draw(shadow)
shadow_draw.polygon([(fold_x, 0), (fold_x, fold_y), (size, fold_y)], fill=(0, 0, 0, 100))
shadow = shadow.filter(ImageFilter.GaussianBlur(15))
icon = Image.alpha_composite(icon, shadow)

# The Fold Flap itself (Glassmorphic / Semi-transparent white)
flap = Image.new('RGBA', (size, size), (0,0,0,0))
flap_draw = ImageDraw.Draw(flap)
flap_draw.polygon([(fold_x, 0), (fold_x, fold_y), (size, fold_y)], fill=(255, 255, 255, 60))
# Add a subtle highlight line on the edge of the fold
flap_draw.line([(fold_x, 0), (fold_x, fold_y)], fill=(255, 255, 255, 150), width=4)
flap_draw.line([(fold_x, fold_y), (size, fold_y)], fill=(255, 255, 255, 100), width=4)
icon = Image.alpha_composite(icon, flap)

# 3. The Slash / Pen (Longer and Beautiful)
# We want a thick 45-degree slash.
slash_length = 500
slash_thickness = 110
center_x, center_y = size // 2, size // 2 + 30 # Slightly lower to balance the fold

# Create a separate layer for the slash so we can add a drop shadow
slash_layer = Image.new('RGBA', (size, size), (0,0,0,0))
slash_draw = ImageDraw.Draw(slash_layer)

# Calculate the 4 corners of the rotated rectangle
angle = math.radians(45)
cos_a = math.cos(angle)
sin_a = math.sin(angle)

dx_l = (slash_length / 2) * cos_a
dy_l = (slash_length / 2) * sin_a
dx_t = (slash_thickness / 2) * sin_a
dy_t = (slash_thickness / 2) * cos_a

p1 = (center_x - dx_l - dx_t, center_y + dy_l - dy_t)
p2 = (center_x - dx_l + dx_t, center_y + dy_l + dy_t)
p3 = (center_x + dx_l + dx_t, center_y - dy_l + dy_t)
p4 = (center_x + dx_l - dx_t, center_y - dy_l - dy_t)

slash_draw.polygon([p1, p2, p3, p4], fill=(255, 255, 255, 255))

# Let's make the tip look like a pen by making one end pointy
# Bottom-left tip: p1 and p2. We can add a triangle extending further down-left.
tip_extend = 60
tip_x = center_x - (slash_length/2 + tip_extend) * cos_a
tip_y = center_y + (slash_length/2 + tip_extend) * sin_a

slash_draw.polygon([p1, p2, (tip_x, tip_y)], fill=(255, 255, 255, 255))

# Add shadow to the slash
slash_shadow = slash_layer.copy()
# Darken the shadow
shadow_data = slash_shadow.getdata()
new_shadow_data = []
for item in shadow_data:
    if item[3] > 0:
        new_shadow_data.append((0, 0, 0, 100)) # Black semi-transparent
    else:
        new_shadow_data.append(item)
slash_shadow.putdata(new_shadow_data)
# Shift and blur shadow
slash_shadow = slash_shadow.transform((size, size), Image.AFFINE, (1, 0, -15, 0, 1, -25))
slash_shadow = slash_shadow.filter(ImageFilter.GaussianBlur(15))

# Combine everything
icon = Image.alpha_composite(icon, slash_shadow)
icon = Image.alpha_composite(icon, slash_layer)

icon.save('tauri-icon-master.png', 'PNG')
print('Successfully generated stunning pro-max icon!')
