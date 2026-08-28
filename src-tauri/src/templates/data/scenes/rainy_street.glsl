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

const float HORIZON = -0.12;

vec3 citySample(vec2 p)
{
    vec3 c = vec3(0.03, 0.04, 0.07);
    float glowNearH = 1.0 - smoothstep(HORIZON, 0.15, p.y);
    c += vec3(0.10, 0.07, 0.11) * glowNearH;

    float xs = p.x * 3.0 + iTime * 0.06;
    float cellIdx = floor(xs);
    float hgt = 0.18 + 0.42 * hash21(vec2(cellIdx, 7.3));
    float lx = fract(xs);

    if (p.y > HORIZON && p.y < HORIZON + hgt && lx > 0.10 && lx < 0.90)
    {
        c = vec3(0.05, 0.06, 0.09);
        vec2 wq = vec2((lx - 0.10) / 0.80 * 10.0, (p.y - HORIZON) / hgt * 14.0);
        vec2 wid = floor(wq);
        vec2 wf = fract(wq) - 0.5;
        float wl = hash21(wid + cellIdx * 31.7);
        float litOn = step(0.55, wl);
        float flick = 0.70 + 0.30 * sin(iTime * (0.4 + wl * 2.0) + wl * 47.0);
        float winMask = 1.0 - smoothstep(0.28, 0.38, max(abs(wf.x), abs(wf.y)));
        c += vec3(1.0, 0.85, 0.55) * winMask * litOn * flick * 0.9;
    }
    return c;
}

float rainLayer(vec2 uv, float seedShift, float scale, float speed, float densityGate)
{
    vec2 g = uv * scale;
    g.x += uv.y * 1.1;
    g.y += iTime * speed + seedShift;
    float columnH = hash21(vec2(floor(g.x), seedShift));
    if (columnH < densityGate)
    {
        return 0.0;
    }
    vec2 f = fract(g) - 0.5;
    float dashIn = smoothstep(0.0, 0.05, f.y) * (1.0 - smoothstep(0.22, 0.32, f.y));
    float across = 1.0 - smoothstep(0.02, 0.06, abs(f.x));
    return across * dashIn * (0.35 + 0.45 * columnH);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    vec3 col;
    if (uv.y > HORIZON)
    {
        col = citySample(uv);
    }
    else
    {
        float depthBelow = max(0.002, HORIZON - uv.y);
        float wobAmp = min(depthBelow * 4.0, 0.09);
        float ripple = fbm(vec2(uv.y * 9.0 - iTime * 2.0, uv.x * 3.0)) - 0.5;

        vec2 mUv = vec2(uv.x + ripple * wobAmp * 2.4, HORIZON * 2.0 - uv.y);
        vec3 refl = citySample(mUv);
        refl += citySample(mUv + vec2(0.015, 0.0));
        refl *= 0.5;

        refl *= vec3(0.30, 0.35, 0.46);
        float wetDark = 0.65 + 0.35 * clamp(depthBelow * 3.0, 0.0, 1.0);
        col = refl * wetDark;

        float shimmer = fbm(vec2(uv.x * 8.0, iTime * 2.0));
        col += vec3(0.90, 0.70, 0.40) * (1.0 - smoothstep(0.004, 0.025, abs(uv.y - HORIZON))) * shimmer * 0.45;
    }

    float rain = rainLayer(uv, 3.1, 16.0, 3.2, 0.55);
    rain += rainLayer(uv, 9.7, 26.0, 5.5, 0.72);
    col += vec3(0.75, 0.82, 0.95) * min(rain, 1.0) * 0.55;

    col *= 1.0 - 0.26 * dot(uv, uv);

    fragColor = vec4(col, 1.0);
}
