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
        p = r * p * 2.03;
        a *= 0.5;
    }
    return v;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    float ra = iTime * 0.045;
    mat2 rm = mat2(cos(ra), sin(ra), -sin(ra), cos(ra));
    vec2 p = rm * uv * 2.1;

    vec2 drift = vec2(iTime * 0.11, -iTime * 0.07);
    float w = fbm(p * 0.9 + drift * 0.4);
    p += (w - 0.5) * 0.95;

    vec2 c = p * 2.0 + drift;

    float h = fbm(c);
    float eps = 0.12;
    float hx = fbm(c + vec2(eps, 0.0));
    float hy = fbm(c + vec2(0.0, eps));
    vec2 g = vec2(hx - h, hy - h) / eps;

    vec3 n = normalize(vec3(-g.x * 1.15, -g.y * 1.15, 1.0));

    float threads = 0.7 + 0.3 * sin(c.x * 230.0 + h * 22.0);
    vec3 ldir = normalize(vec3(0.42, 0.62, 0.66));
    float dif = max(dot(n, ldir), 0.0);
    float spec = pow(max(dot(normalize(ldir + vec3(0.0, 0.0, 1.0)), n), 0.0), 52.0) * threads;
    float sheen = pow(1.0 - abs(n.x), 3.0);

    vec3 base = mix(vec3(0.30, 0.05, 0.11), vec3(0.87, 0.70, 0.38), smoothstep(0.24, 0.86, h));
    vec3 col = base * (0.16 + 0.88 * dif)
             + vec3(1.0, 0.96, 0.88) * spec * 1.25
             + base * sheen * 0.4
             + base * fbm(p * 26.0) * 0.08;

    col *= 1.0 - 0.42 * dot(uv, uv);
    fragColor = vec4(col, 1.0);
}
