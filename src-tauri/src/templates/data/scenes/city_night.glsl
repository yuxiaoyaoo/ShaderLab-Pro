float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float vnoise(vec2 p)
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
    float s = 0.0;
    float a = 0.5;
    mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
    for (int n = 0; n < 5; n++)
    {
        s += a * vnoise(p);
        p = m * p;
        a *= 0.5;
    }
    return s;
}

float buildingH(float id, float mxH, float seed)
{
    return mxH * (0.30 + 0.78 * pow(hash21(vec2(id, seed)), 1.7));
}

float cityCover(vec2 q, float sc, float mxH, float seed)
{
    float cx = q.x * sc + seed;
    float id = floor(cx);
    float u = fract(cx);
    float h = buildingH(id, mxH, seed);
    return step(q.y, h) * step(0.012, u) * step(u, 0.988);
}

vec3 cityWindows(vec2 q, float t, float sc, float mxH, float seed, float ratio, float glow)
{
    float cx = q.x * sc + seed;
    float id = floor(cx);
    float u = fract(cx);
    float h = buildingH(id, mxH, seed);
    float zone = step(q.y, h - 0.022) * step(0.05, u) * step(u, 0.95) * step(0.02, q.y);
    vec2 wid = vec2(floor(cx * 3.0), floor(q.y * sc * 20.0));
    vec2 wf = fract(vec2(cx * 3.0, q.y * sc * 20.0));
    float mx = smoothstep(0.16, 0.30, wf.x) * smoothstep(0.88, 0.74, wf.x);
    float my = smoothstep(0.26, 0.40, wf.y) * smoothstep(0.80, 0.66, wf.y);
    float lit = step(hash21(wid + seed * 1.7), ratio);
    float flick = hash21(wid * 1.31 + floor(t * 0.7) + seed);
    lit *= step(0.02, flick) * step(flick, 0.95);
    vec3 tint = mix(vec3(1.0, 0.68, 0.30), vec3(0.68, 0.86, 1.0), step(0.76, hash21(wid * 2.3 + seed + 13.0)));
    return tint * (zone * mx * my * lit * glow);
}

vec3 cityBeacons(vec2 q, float t, float sc, float mxH, float seed)
{
    float cx = q.x * sc + seed;
    float id = floor(cx);
    float dx = fract(cx) - 0.5;
    float h = buildingH(id, mxH, seed);
    float has = step(0.55, hash21(vec2(id, seed + 51.0)));
    vec2 bp = vec2(dx, q.y - h - 0.010);
    float d = dot(bp, bp * vec2(1.0, 26.0));
    float blink = smoothstep(0.35, 0.9, 0.5 + 0.5 * sin(t * 2.4 + id * 2.3));
    return vec3(1.0, 0.14, 0.10) * exp(-d * 180.0) * has * blink * 2.4;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    float t = iTime;
    const float WL = -0.16;
    vec3 col = vec3(0.0);

    if (uv.y > WL)
    {
        vec2 q = uv - vec2(0.0, WL);

        col = mix(vec3(0.06, 0.05, 0.13), vec3(0.010, 0.016, 0.045), smoothstep(0.0, 0.8, q.y));
        col += vec3(0.10, 0.05, 0.14) * exp(-q.y * 7.0) * 0.7;

        vec2 sg = floor(q * 46.0);
        float sr = hash21(sg);
        float star = smoothstep(0.993, 1.0, sr) * smoothstep(0.30, 0.65, q.y);
        star *= 0.5 + 0.5 * sin(t * 2.2 + sr * 91.0);
        col += vec3(0.85, 0.9, 1.0) * star * 0.85;

        vec2 mp = q - vec2(0.46, 0.47);
        float md = length(mp);
        col += vec3(0.92, 0.90, 0.80) * smoothstep(0.032, 0.027, md) * 1.15;
        col += vec3(0.50, 0.55, 0.78) * exp(-md * 11.0) * 0.30;

        vec2 fq = vec2(q.x, q.y * 0.94) + vec2(0.31, 0.0);
        float fcov = cityCover(fq, 2.4, 0.30, 131.0);
        col = mix(col, vec3(0.045, 0.052, 0.10), fcov);
        col += cityWindows(fq, t, 2.4, 0.30, 131.0, 0.14, 0.50);

        float ncov = cityCover(q, 1.3, 0.46, 271.0);
        col = mix(col, vec3(0.020, 0.024, 0.052), ncov);
        col += cityWindows(q, t, 1.3, 0.46, 271.0, 0.28, 1.30);
        col += cityBeacons(q, t, 1.3, 0.46, 271.0);

        col = mix(col, vec3(0.07, 0.05, 0.12), exp(-q.y * 16.0) * 0.55);
    }
    else
    {
        float dp = WL - uv.y;
        float wob = (fbm(vec2(uv.x * 13.0, t * 1.1)) - 0.5) * 0.05 * smoothstep(0.0, 0.10, dp);
        vec2 rq = vec2(uv.x + wob, dp);

        vec3 refl = vec3(0.0);
        refl += vec3(0.09, 0.07, 0.16) * exp(-dp * 8.0) * 0.55;

        vec2 fq = vec2(rq.x, rq.y * 0.94) + vec2(0.31, 0.0);
        refl += vec3(0.045, 0.052, 0.10) * cityCover(fq, 2.4, 0.30, 131.0) * 0.85;
        refl += cityWindows(fq, t, 2.4, 0.30, 131.0, 0.14, 0.45) * 0.9;

        refl += vec3(0.020, 0.024, 0.052) * cityCover(rq, 1.3, 0.46, 271.0) * 0.95;
        refl += cityWindows(rq, t, 1.3, 0.46, 271.0, 0.28, 1.20) * 0.95;
        refl += cityBeacons(rq, t, 1.3, 0.46, 271.0);

        float fade = exp(-dp * 2.6);
        float rip = fbm(vec2(uv.x * 22.0, dp * 24.0 - t * 2.2));
        float stripes = 0.45 + 0.65 * rip;
        float dash = 0.35 + 0.85 * smoothstep(0.25, 0.75, sin(dp * 150.0 - t * 2.6 + rip * 9.0));

        col = mix(vec3(0.007, 0.011, 0.022), vec3(0.013, 0.019, 0.036), clamp(dp * 2.8, 0.0, 1.0));
        col += refl * fade * stripes * dash;

        vec2 mg = vec2(uv.x - 0.46, dp);
        float glit = exp(-abs(mg.x) * 26.0) * exp(-dp * 2.2);
        glit *= pow(max(0.0, sin(dp * 120.0 + t * 3.2 + fbm(mg * 22.0 + t * 0.6) * 10.0)), 4.0);
        col += vec3(0.9, 0.84, 0.62) * glit * 0.14;

        col += vec3(0.22, 0.19, 0.36) * exp(-dp * 80.0) * 0.6;
    }

    vec2 vv = uv * vec2(0.8, 1.25);
    col *= 1.0 - 0.40 * dot(vv, vv);
    col = 1.0 - exp(-col * 1.7);
    fragColor = vec4(col, 1.0);
}
