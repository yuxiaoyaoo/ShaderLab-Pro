float hash21(vec2 p)
{
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec3 col = mix(vec3(0.06, 0.09, 0.14), vec3(0.14, 0.19, 0.27), clamp(uv.y + 0.5, 0.0, 1.0));

    for (int layer = 0; layer < 3; layer++)
    {
        float fl = float(layer);
        float scale = 10.0 + 6.0 * fl;
        float wind = 0.6 + 0.25 * fl;
        vec2 vel = vec2(wind, -(0.8 + 0.35 * fl));
        vec2 grid = uv * scale + vel * iTime * scale * 0.35;
        grid.x += sin(iTime * 0.9 + fl * 2.1) * 1.5;
        vec2 cell = floor(grid);
        vec2 f = fract(grid) - 0.5;

        float h = hash21(cell + fl * 31.7);
        if (h > 0.72)
        {
            vec2 off = vec2(hash21(cell + 5.5), hash21(cell + 9.9)) - 0.5;
            off.x += 0.25 * sin(iTime * (1.5 + fl) + h * 50.0);
            float r = 0.04 + 0.9 * h / scale;
            float d = length(f - off);
            float flake = 1.0 - smoothstep(r * 0.4, r, d);
            col = mix(col, vec3(0.92, 0.96, 1.0), flake * (0.30 + 0.25 * fl));
        }
    }

    float groundHaze = 1.0 - smoothstep(-0.5, -0.25, uv.y);
    col = mix(col, vec3(0.25, 0.32, 0.42), groundHaze * 0.4);

    fragColor = vec4(col, 1.0);
}
