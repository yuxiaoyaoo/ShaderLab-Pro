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
    return mix(mix(a, b, f.x), mix(dd, c, f.x), f.y);
}

float fbm(vec2 p)
{
    float v = 0.0;
    float a = 0.5;
    mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
    for (int i = 0; i < 4; i++)
    {
        v += a * noise(p);
        p = r * p * 2.02;
        a *= 0.5;
    }
    return v;
}

float hgt(vec2 p)
{
    vec2 q = p;
    q += (fbm(p * 1.35 + vec2(iTime * 0.13, 0.0)) - 0.5) * 0.75;
    q += (fbm(p * 2.7 - vec2(0.0, iTime * 0.10)) - 0.5) * 0.32;
    return fbm(q + vec2(iTime * 0.05, iTime * 0.035));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec2 p = uv * 1.85;

    float h = hgt(p);
    float eps = 0.055;
    float hx = hgt(p + vec2(eps, 0.0));
    float hy = hgt(p + vec2(0.0, eps));
    vec3 n = normalize(vec3(-(hx - h) / eps * 1.3, -(hy - h) / eps * 1.3, 1.0));

    vec3 rd = reflect(vec3(0.0, 0.0, -1.0), n);

    vec3 sky = mix(vec3(0.03, 0.045, 0.07), vec3(0.44, 0.56, 0.74), smoothstep(-0.65, 0.9, rd.y));
    float pnl = pow(max(sin(rd.x * 4.6 + rd.y * 2.1), 0.0), 8.0) * clamp(0.25 + 0.55 * rd.y, 0.0, 1.0);
    vec3 sdir = normalize(vec3(0.62, 0.68, -0.38));
    float spot = pow(max(dot(rd, sdir), 0.0), 110.0) * 4.2;

    float fre = pow(1.0 - max(n.z, 0.0), 4.0);
    vec3 col = (sky + vec3(1.0, 0.97, 0.92) * pnl * 0.75) * (0.35 + 0.85 * fre) + vec3(1.0, 0.98, 0.94) * spot;
    col += vec3(0.14, 0.15, 0.17) * (0.3 + 0.5 * h);

    col *= 1.0 - 0.36 * dot(uv, uv);
    col = 1.0 - exp(-col * 1.45);
    fragColor = vec4(col, 1.0);
}
