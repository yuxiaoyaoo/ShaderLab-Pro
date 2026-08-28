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
    for (int i = 0; i < 6; i++)
    {
        v += a * noise(p);
        p = r * p * 2.04;
        a *= 0.5;
    }
    return v;
}

float terrainHeight(vec2 xz)
{
    vec2 w = xz - vec2(0.0, iTime * 1.4);
    float h = fbm(w * 0.35) * 2.4 - 0.9;
    h -= (1.0 - smoothstep(0.15, 1.3, abs(w.x))) * 0.55;
    return h;
}

vec3 terrainNormal(vec2 xz)
{
    float e = 0.02;
    float hx0 = terrainHeight(xz - vec2(e, 0.0));
    float hx1 = terrainHeight(xz + vec2(e, 0.0));
    float hz0 = terrainHeight(xz - vec2(0.0, e));
    float hz1 = terrainHeight(xz + vec2(0.0, e));
    return normalize(vec3(hx0 - hx1, 2.0 * e, hz0 - hz1));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    vec3 ro = vec3(0.0, terrainHeight(vec2(0.0, 0.0)) + 0.42, 0.0);
    vec3 rd = normalize(vec3(uv, 1.4));

    vec3 sky = mix(vec3(1.0, 0.62, 0.36), vec3(0.25, 0.35, 0.58), clamp(rd.y * 1.6, 0.0, 1.0));
    vec3 col = sky;

    float t = 0.0;
    bool hit = false;
    for (int i = 0; i < 130; i++)
    {
        vec3 p = ro + rd * t;
        float dh = p.y - terrainHeight(p.xz);
        if (dh < 0.002 * t + 0.0015)
        {
            hit = true;
            break;
        }
        t += max(dh * 0.5, 0.006);
        if (t > 34.0)
        {
            break;
        }
    }

    if (hit)
    {
        vec3 p = ro + rd * t;
        vec3 n = terrainNormal(p.xz);

        vec3 lightDir = normalize(vec3(0.55, 0.35, -0.65));
        float sun = max(dot(n, lightDir), 0.0);
        float amb = 0.35 + 0.35 * clamp(n.y, 0.0, 1.0);

        float rockiness = 1.0 - smoothstep(0.55, 0.85, n.y);
        float snowZone = smoothstep(0.9, 1.7, p.y) * smoothstep(0.45, 0.75, n.y);
        vec3 grass = vec3(0.16, 0.30, 0.14);
        vec3 rock = vec3(0.35, 0.31, 0.28);
        vec3 snowc = vec3(0.88, 0.91, 0.95);
        vec3 mat = mix(grass, rock, rockiness);
        mat = mix(mat, snowc, snowZone);

        col = mat * amb + mat * vec3(1.0, 0.72, 0.42) * sun * 1.5;
    }

    float fog = 1.0 - exp(-t * t * 0.0016);
    col = mix(col, sky, fog);

    fragColor = vec4(col, 1.0);
}
