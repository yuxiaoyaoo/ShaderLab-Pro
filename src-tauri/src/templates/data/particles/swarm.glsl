float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    float dr = length(uv);
    vec3 col = mix(vec3(0.045, 0.036, 0.05), vec3(0.13, 0.085, 0.045), exp(-dr * dr * 2.2));

    vec2 cc = vec2(sin(iTime * 0.53) * 0.5, 0.26 * sin(iTime * 0.37 + 1.2));
    cc += 0.12 * vec2(sin(iTime * 1.13 + 0.7), cos(iTime * 0.87));

    col += vec3(1.0, 0.62, 0.22) * exp(-dot(uv - cc, uv - cc) * 260.0) * 0.32;

    for (int i = 0; i < 42; i++)
    {
        float fi = float(i);
        float hs = hash21(vec2(fi, 1.1));
        float hp = hash21(vec2(fi, 2.7));
        float hr = hash21(vec2(fi, 3.9));
        float hq = hash21(vec2(fi, 5.3));

        float phi = 6.2831853 * hp;
        float sgn = hs > 0.5 ? 1.0 : -1.0;
        float theta = phi + sgn * (1.5 + 2.4 * hs) * iTime + 0.4 * sin(iTime * 3.3 + fi) * hr;

        float radius = 0.05 + 0.23 * pow(hr, 1.5) * (0.78 + 0.22 * sin(iTime * 1.9 + fi * 0.9));
        float squash = 0.5 + 0.42 * sin(hq * 12.0);
        vec2 eLocal = vec2(cos(theta), sin(theta) * squash) * radius;

        float cp = cos(phi), sp = sin(phi);
        vec2 pos = cc + mat2(cp, sp, -sp, cp) * eLocal;

        float size = 0.006 + 0.007 * fract(hr * 7.0);
        float d = length(uv - pos);
        float body = smoothstep(size * 1.7, size * 0.45, d);

        float bright = 0.5 + 0.5 * sin(theta + phi * 3.0);
        float flick = 0.84 + 0.16 * sin(iTime * (25.0 + 9.0 * hr) + fi * 9.0);
        vec3 bc = mix(vec3(1.0, 0.74, 0.28), vec3(0.95, 0.45, 0.15), fract(hr * 3.0));
        col += bc * body * (0.35 + 0.75 * bright) * flick;
    }

    col *= 1.0 - 0.38 * dot(uv, uv);
    fragColor = vec4(col, 1.0);
}
