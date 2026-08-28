float hash21(vec2 p)
{
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
}

float noise(vec2 p)
{
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float fbm(vec2 p)
{
    float v = 0.0;
    float a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 4; i++)
    {
        v += a * noise(p);
        p = r * p * 2.03;
        a *= 0.5;
    }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    float deepK = 1.0 - smoothstep(-0.55, 0.35, uv.y);
    vec3 col = mix(vec3(0.02, 0.16, 0.24), vec3(0.00, 0.03, 0.09), deepK);

    vec2 cp = uv * 3.4;
    float ca = fbm(cp + iTime * 0.7) * fbm(cp - iTime * 0.9) * 4.2;
    float caustic = pow(clamp(ca, 0.0, 1.0), 1.4);
    float cw = (1.0 - deepK) * 0.85 + 0.10;
    col += vec3(0.55, 0.95, 0.85) * caustic * cw * 0.50;

    float beamPattern = sin(uv.x * 14.0 + uv.y * 5.0 - iTime * 0.9);
    float beams = pow(max(beamPattern, 0.0), 3.0) * (1.0 - deepK);
    col += vec3(0.40, 0.70, 0.75) * beams * 0.30;

    for (int i = 0; i < 30; i++)
    {
        float fi = float(i);
        float h1 = hash21(vec2(fi, 1.7));
        float h2 = hash21(vec2(fi, 3.9));
        float h3 = hash21(vec2(fi, 6.1));

        float py = fract(h2 + iTime * (0.015 + 0.04 * h3)) * 1.5 - 0.75;
        float px = h1 * 2.4 - 1.2 + 0.06 * sin(iTime * 0.6 + fi);
        float pd = length(uv - vec2(px, py));
        float dust = (1.0 - smoothstep(0.002, 0.010, pd));
        float glint = 0.5 + 0.5 * sin(iTime * 2.0 + fi * 2.3);
        col += vec3(0.75, 0.92, 0.95) * dust * glint * 0.30;
    }

    col *= 1.0 - 0.32 * dot(uv, uv);

    fragColor = vec4(col, 1.0);
}
