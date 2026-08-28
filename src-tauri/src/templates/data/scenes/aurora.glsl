float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
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
    float dd = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, dd, f.x), f.y);
}

float fbm(vec2 p)
{
    float v = 0.0;
    float a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 5; i++)
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

    vec3 col = mix(vec3(0.055, 0.085, 0.135), vec3(0.008, 0.016, 0.045), smoothstep(-0.15, 0.7, uv.y));

    vec2 sq = uv * 38.0;
    vec2 sid = floor(sq);
    vec2 sf = fract(sq) - 0.5;
    float sh = hash21(sid);
    if (sh > 0.985 && uv.y > -0.22)
    {
        vec2 soff = vec2(hash21(sid + 1.3), hash21(sid + 2.6)) - 0.5;
        float sd2 = length(sf - soff * 0.6);
        float tw = 0.5 + 0.5 * sin(iTime * (1.3 + 3.0 * fract(sh * 61.0)) + sh * 77.0);
        col += vec3(0.85, 0.9, 1.0) * (1.0 - smoothstep(0.02, 0.09, sd2)) * tw * 0.55;
    }

    float aAcc = 0.0;
    for (int i = 0; i < 3; i++)
    {
        float fi = float(i);
        float sc = 1.5 + 0.8 * fi;
        float wp = fbm(vec2(uv.x * sc * 0.55 - iTime * 0.12 - fi * 1.7, uv.y * 1.6 + iTime * 0.06));
        float cx = (-0.5 + 0.52 * fi) + (wp - 0.5) * 1.6;
        float bw = 7.5 - 1.4 * fi;
        float band = exp(-pow(abs(uv.x - cx) * bw, 1.35));
        float vert = smoothstep(-0.34, 0.14, uv.y) * exp(-max(uv.y - 0.1, 0.0) * (3.0 - 0.45 * fi));
        float str = 0.6 + 0.4 * sin(cx * 46.0 + wp * 8.0 + iTime * 0.5 + fi * 2.4);
        float pulse = 0.75 + 0.25 * sin(iTime * 0.9 + fi * 1.9);

        vec3 aCol = mix(vec3(0.08, 0.9, 0.45), vec3(0.5, 0.2, 0.8), smoothstep(-0.05, 0.5, uv.y));
        float inten = band * vert * str * pulse * (0.5 - 0.09 * fi);
        col += aCol * inten;
        aAcc += inten;
    }

    float rf = -0.30 + 0.32 * (fbm(vec2(uv.x * 1.05 + 2.3)) - 0.5);
    float rn = -0.42 + 0.26 * (fbm(vec2(uv.x * 1.7 + 7.9)) - 0.5);

    float silFar = 1.0 - smoothstep(rf - 0.005, rf + 0.005, uv.y);
    col = mix(col, vec3(0.035, 0.05, 0.075), silFar * 0.9);

    float rim = exp(-abs(uv.y - rn) * 150.0) * clamp(aAcc * 1.2, 0.0, 1.0);
    col += vec3(0.25, 0.9, 0.45) * rim * 0.4 * (1.0 - silFar);

    float silNear = 1.0 - smoothstep(rn - 0.005, rn + 0.005, uv.y);
    col = mix(col, vec3(0.018, 0.032, 0.042), silNear);

    col *= 1.0 - 0.35 * dot(uv * vec2(1.0, 1.4), uv * vec2(1.0, 1.4));
    col = 1.0 - exp(-col * 1.3);
    fragColor = vec4(col, 1.0);
}
