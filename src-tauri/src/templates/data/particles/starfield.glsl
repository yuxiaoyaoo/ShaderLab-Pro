float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec3 col = vec3(0.02, 0.03, 0.08);

    for (int layer = 0; layer < 3; layer++)
    {
        float fl = float(layer);
        float scale = 14.0 - 3.5 * fl;
        vec2 grid = uv * scale + vec2(fl * 17.13, iTime * (0.15 + 0.12 * fl) * scale);
        vec2 cell = floor(grid);
        vec2 f = fract(grid) - 0.5;

        float h = hash21(cell + fl * 7.7);
        if (h > 0.90)
        {
            vec2 off = vec2(hash21(cell + 11.1), hash21(cell + 22.2)) - 0.5;
            off *= 0.6;
            float d = length(f - off);
            float twinkle = 0.55 + 0.45 * sin(iTime * (2.0 + 3.0 * h) + h * 40.0);
            float star = 1.0 - smoothstep(0.0, 0.10, d);
            vec3 tint = mix(vec3(0.65, 0.78, 1.0), vec3(1.0, 0.86, 0.6), fract(h * 13.7));
            col += star * tint * twinkle * (0.35 + 0.35 * fl);
        }
    }

    fragColor = vec4(col, 1.0);
}
